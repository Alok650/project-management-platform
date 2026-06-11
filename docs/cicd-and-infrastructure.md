# CI/CD and Infrastructure

This document describes the full deployment pipeline, production infrastructure, and configuration for the project-management-platform.

---

## Overview

```
GitHub push to main
       │
       ├─ CI job: typecheck + tests + Docker build (no push)
       │
       └─ CD job (after CI): build image → push to ghcr.io → SSH deploy to VM
                                                              │
                                                              ├─ docker compose up mysql + redis (--wait)
                                                              ├─ docker compose up elasticmq
                                                              ├─ run TypeORM migrations (ephemeral container)
                                                              └─ docker compose up app (--wait, zero-downtime)
```

---

## GitHub Actions

### CI — `.github/workflows/ci.yml`

Runs on every push and pull request to `main`. Two jobs run in sequence:

**`test` job**
- Node 20, `npm ci`, TypeScript typecheck (`tsc --noEmit`), Jest tests with coverage summary
- No external services — unit/integration tests are designed to run without a database

**`docker-build` job** (needs: `test`)
- Builds the multi-stage Docker image using Buildx with GitHub Actions layer caching
- Does **not** push; validates the image compiles and layers are correct

Concurrency: cancels in-progress CI runs for the same branch on new pushes.

---

### CD — `.github/workflows/cd.yml`

Runs on push to `main` only. Concurrency group `deploy-production` — new pushes queue, they do not cancel a running deploy.

**`publish` job**

1. Logs in to `ghcr.io` using `GITHUB_TOKEN`
2. Computes two tags via `docker/metadata-action`:
   - `ghcr.io/alok650/project-management-platform:sha-<full-commit-sha>` (immutable, used by deploy)
   - `ghcr.io/alok650/project-management-platform:latest` (floating, updated on every main push)
3. Builds and pushes with GHA layer cache

**`deploy` job** (needs: `publish`, environment: `production`)

Connects to the production VM via SSH (`appleboy/ssh-action`) and runs:

```bash
# 1. Pull the new image
echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
docker pull ghcr.io/alok650/project-management-platform:$IMAGE_TAG

# 2. Bring up MySQL and Redis, block until their healthchecks pass
docker compose -f docker-compose.production.yml up -d --wait mysql redis

# 3. Start ElasticMQ without --wait (app tolerates its absence at startup)
docker compose -f docker-compose.production.yml up -d elasticmq

# 4. Run TypeORM migrations in an ephemeral container on the app_default network
docker run --rm --env-file .env \
  --network app_default \
  -e NODE_ENV=production \
  ghcr.io/alok650/project-management-platform:$IMAGE_TAG \
  node -e "
    const { AppDataSource } = require('./dist/config/database');
    AppDataSource.initialize()
      .then(() => AppDataSource.runMigrations())
      .then(() => process.exit(0))
      .catch(e => { console.error(e); process.exit(1); });
  "

# 5. Zero-downtime restart: bring up new app container, wait for healthcheck
APP_IMAGE=ghcr.io/alok650/project-management-platform:$IMAGE_TAG \
  docker compose -f docker-compose.production.yml up -d --no-deps --wait app

# 6. Prune dangling images
docker image prune -f
```

**Required GitHub secrets:**

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | `140.245.216.53` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | ed25519 private key authorised on the VM |
| `DEPLOY_DIR` | `/home/ubuntu/app` |

The `production` GitHub Environment is configured with no approval gates — deploys are automatic.

---

## Production VM

**Provider:** Oracle Cloud Infrastructure (Always Free tier)
**Shape:** VM.Standard.E2.1.Micro — 1 OCPU, 6 GB RAM
**OS:** Ubuntu 22.04 LTS
**IP:** `140.245.216.53`
**Public hostname:** `140-245-216-53.sslip.io` (sslip.io maps the IP embedded in the hostname — no DNS management needed)

### Nginx

Installed directly on the VM (not containerised) as the TLS-terminating reverse proxy.

```nginx
# /etc/nginx/sites-enabled/pmp
server {
    listen 80;
    server_name 140-245-216-53.sslip.io;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 140-245-216-53.sslip.io;

    ssl_certificate     /etc/letsencrypt/live/140-245-216-53.sslip.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/140-245-216-53.sslip.io/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

TLS certificate issued by Let's Encrypt via Certbot. Auto-renewal is managed by a systemd timer (`certbot.timer`).

### Firewall (ufw)

```
22/tcp   — SSH
80/tcp   — HTTP (redirects to HTTPS)
443/tcp  — HTTPS
```

Oracle Cloud VCN Security Lists also allow ports 22, 80, 443 from `0.0.0.0/0`.

Port 3000 is **not** exposed externally — the app container binds only to `localhost:3000` and traffic arrives through Nginx.

---

## Docker Compose — Production Stack

File: `docker-compose.production.yml`

Four services run on a single `app_default` bridge network:

### `app`

```yaml
image: ${APP_IMAGE:-ghcr.io/alok650/project-management-platform:latest}
restart: unless-stopped
ports: ["3000:3000"]
depends_on:
  mysql:  { condition: service_healthy }
  redis:  { condition: service_healthy }
  elasticmq: { condition: service_started }
healthcheck:
  test: wget -qO- http://localhost:3000/api/health/live || exit 1
  interval: 15s  timeout: 5s  retries: 3  start_period: 30s
logging: json-file, max 50 MB / 5 files
```

### `mysql`

```yaml
image: mysql:8.0
volumes: mysql_data:/var/lib/mysql
command flags:
  --character-set-server=utf8mb4
  --collation-server=utf8mb4_unicode_ci
  --innodb-buffer-pool-size=256M    # 256 MB of the 6 GB VM RAM
  --max-connections=500             # matches 500-VU load test ceiling
  --innodb-ft-result-cache-limit=2147483648   # 2 GB FULLTEXT cache → fewer flush-to-disk under write load
healthcheck:
  mysqladmin ping -h localhost -u root -p$DB_ROOT_PASSWORD
  interval: 10s  timeout: 5s  retries: 10  start_period: 40s
logging: json-file, max 20 MB / 3 files
```

### `redis`

```yaml
image: redis:7.4-alpine
volumes: redis_data:/data
command flags:
  --save 60 1           # persist to disk if ≥1 key changed in 60s
  --loglevel warning
  --maxmemory 256mb
  --maxmemory-policy allkeys-lru   # evict LRU keys when memory full
healthcheck: redis-cli ping
  interval: 5s  timeout: 3s  retries: 5
logging: json-file, max 10 MB / 3 files
```

### `elasticmq`

```yaml
image: softwaremill/elasticmq-native:latest
volumes: ./elasticmq.conf:/opt/elasticmq.conf
healthcheck:
  bash -c '>/dev/tcp/localhost/9324' 2>/dev/null
  interval: 5s  timeout: 5s  retries: 5
logging: json-file, max 10 MB / 3 files
```

> `elasticmq-native` has no `curl` binary. The healthcheck uses bash's `/dev/tcp` pseudo-device to test TCP connectivity on port 9324. Port 9325 (the old management UI port) is not configured in `elasticmq.conf` and is never bound.

---

## ElasticMQ Configuration — `elasticmq.conf`

ElasticMQ runs as an SQS-compatible in-process queue. The config file is mounted at `/opt/elasticmq.conf` inside the container.

```hocon
include classpath("application.conf")

queues {
  notification-delivery-dlq {
    defaultVisibilityTimeout = 30 seconds
    delay = 0 seconds
    receiveMessageWait = 0 seconds
  }
  notification-delivery {
    defaultVisibilityTimeout = 10 seconds
    delay = 0 seconds
    receiveMessageWait = 0 seconds
    deadLetterQueue {
      name = notification-delivery-dlq
      maxReceiveCount = 3    # 3 delivery failures → move to DLQ
    }
  }
}

node-address {
  protocol = http
  host = "*"
  port = 9324
}

rest-sqs {
  enabled = true
  bind-port = 9324
  bind-hostname = "0.0.0.0"
  sqs-limits = strict
}
```

Two queues:
- `notification-delivery` — primary queue consumed by `SqsConsumer`. Visibility timeout 10s; messages reappear if the consumer crashes mid-processing.
- `notification-delivery-dlq` — receives messages that fail delivery 3 times. Visibility timeout 30s for manual inspection.

The queue URL used by the app is `http://elasticmq:9324/000000000000/notification-delivery` (the `000000000000` account ID is ElasticMQ's fixed dummy value).

---

## Application Configuration — `.env`

The `.env` file lives at `/home/ubuntu/app/.env` on the VM (not in git; copied from `.env.example` during initial setup).

```bash
NODE_ENV=production
PORT=3000

# MySQL — matches the docker-compose service name as hostname
DB_HOST=mysql
DB_PORT=3306
DB_NAME=pmp
DB_USER=pmp
DB_PASSWORD=<secret>
DB_ROOT_PASSWORD=<secret>
DB_POOL_MAX=50          # TypeORM connectionLimit; 50 connections × 1 process

# Redis
REDIS_URL=redis://redis:6379

# Auth
JWT_SECRET=<min-32-char-secret>
JWT_EXPIRES_IN=7d

# SQS / ElasticMQ
AWS_REGION=us-east-1
AWS_ENDPOINT=http://elasticmq:9324
AWS_ACCESS_KEY_ID=x     # ElasticMQ accepts any non-empty value
AWS_SECRET_ACCESS_KEY=x
SQS_NOTIFICATION_QUEUE_URL=http://elasticmq:9324/000000000000/notification-delivery

# Rate limiter
RATE_LIMIT_MAX=100      # requests per minute per IP (set to 50000 during load testing)

LOG_LEVEL=info
```

`DB_POOL_MAX=50` gives each TypeORM process 50 MySQL connections. MySQL `--max-connections=500` leaves room for migrations, healthchecks, and a future second replica.

---

## Docker Image — `Dockerfile`

Two-stage build:

**Stage 1 — `builder` (node:20-alpine)**

```
npm ci --include=dev
tsc  →  dist/
```

**Stage 2 — `runtime` (node:20-alpine)**

```
npm ci --omit=dev   (no devDependencies, no tsc, no ts-node)
COPY --from=builder /app/dist ./dist
USER node           (non-root, uid 1000)
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

The final image contains no TypeScript source, no dev tools, and runs as a non-root user.

---

## TypeORM Migrations

Migrations live in `src/migrations/` and compile to `dist/migrations/`. They run as a one-shot `docker run` step in CD — an ephemeral container on the `app_default` network — before the app container is updated. This ensures schema is always ahead of the code that depends on it.

The migration runner calls `AppDataSource.initialize()` then `AppDataSource.runMigrations()` and exits. It uses the same image as the app deployment so the migration code is always in sync with the application code.

---

## Health Checks

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health/live` | Liveness — returns 200 if the process is up. Used by Docker healthcheck and Nginx upstream checks. |
| `GET /api/health/ready` | Readiness — checks MySQL and Redis connectivity. Not currently wired into Docker; available for future load-balancer use. |

---

## Container Registry

Images are stored in the GitHub Container Registry (`ghcr.io`) under the repository owner's namespace:

```
ghcr.io/alok650/project-management-platform:sha-<40-char-sha>   ← immutable per commit
ghcr.io/alok650/project-management-platform:latest               ← floating, tracks main
```

Old images are not automatically pruned — `docker image prune -f` runs after each deploy to remove dangling layers.

---

## Known Constraints and Trade-offs

| Constraint | Detail |
|------------|--------|
| Single OCPU VM | All four services share one CPU core. Write throughput is the bottleneck at high concurrency (see load test findings). |
| Single DB instance | No read replicas. TypeORM pool (`DB_POOL_MAX=50`) is the only concurrency control between the app and MySQL. |
| No TLS between app and MySQL/Redis | All four containers are on the same Docker bridge network (`app_default`); inter-service traffic does not leave the VM. |
| ElasticMQ is ephemeral | Queue state lives only in container memory — not persisted to disk. A container restart drops undelivered messages. Suitable for notifications; would need a persistent queue (RabbitMQ, AWS SQS) for durable workflows. |
| Single deployment replica | Zero-downtime deploys use Docker's `--no-deps --wait` flag to swap the app container. There is a brief window (~healthcheck interval) where in-flight requests may be dropped. |
