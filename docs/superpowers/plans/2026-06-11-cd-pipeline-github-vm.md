# CD Pipeline, GitHub Repository & VM Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a clean public GitHub repository and wire up a fully automated CI/CD pipeline that deploys every `main` push to an Oracle VM at `http://140.245.216.53` via Nginx + Docker Compose.

**Architecture:** GitHub Actions builds a Docker image, pushes it to GHCR (`ghcr.io/alok650/project-management-platform`), then SSHs into the VM to pull the new image, run TypeORM migrations, and zero-downtime restart the app container. Nginx on the VM proxies port 80 → localhost:3000. MySQL and Redis run as sibling containers in the same Compose stack.

**Tech Stack:** GitHub Actions, GHCR, Docker Compose v2, Nginx (systemd), Ubuntu 24.04, Node.js 20 / TypeScript, TypeORM, MySQL 8, Redis 7.

---

## File Map

| Action | Path |
|--------|------|
| Delete | `docs/SCALING.md` |
| Delete | `docs/specs.md` |
| Delete | `docs/superpowers/plans/2026-06-10-project-management-platform.md` |
| Modify | `.gitignore` |
| Modify | `.github/workflows/cd.yml` |
| Modify | `docker-compose.production.yml` (default image name) |
| Create | `LICENSE` |
| Create | `CONTRIBUTING.md` |
| Create | `.github/PULL_REQUEST_TEMPLATE.md` |

---

## Task 1: Clean up repository files

**Files:**
- Delete: `docs/SCALING.md`, `docs/specs.md`, `docs/superpowers/plans/2026-06-10-project-management-platform.md`
- Modify: `.gitignore`
- Modify: `docker-compose.production.yml` (line 9 — default image tag)

- [ ] **Step 1: Delete internal planning docs**

```bash
rm docs/SCALING.md docs/specs.md
rm docs/superpowers/plans/2026-06-10-project-management-platform.md
```

- [ ] **Step 2: Update .gitignore**

Replace the entire `.gitignore` with:

```gitignore
# Dependencies & build
node_modules/
dist/
*.tsbuildinfo

# Environment
.env
.env.*
!.env.example

# Logs & coverage
*.log
coverage/

# OS
.DS_Store

# Internal planning docs
docs/superpowers/plans/
```

- [ ] **Step 3: Fix default image name in docker-compose.production.yml**

In `docker-compose.production.yml`, change the `image:` line under `app:` from:

```yaml
    image: ${APP_IMAGE:-ghcr.io/org/product-management-platform:latest}
```

to:

```yaml
    image: ${APP_IMAGE:-ghcr.io/alok650/project-management-platform:latest}
```

- [ ] **Step 4: Verify deletions and diff**

```bash
ls docs/
git diff .gitignore docker-compose.production.yml
```

Expected `ls docs/` output: `adr  superpowers`  
Expected diff: `.gitignore` expanded, `docker-compose.production.yml` image name updated.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: clean up repo — remove internal docs, expand gitignore, fix image name"
```

---

## Task 2: Add standard OSS files

**Files:**
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Create LICENSE (MIT)**

Create `LICENSE` with this exact content:

```
MIT License

Copyright (c) 2026 Alok

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Create CONTRIBUTING.md**

Create `CONTRIBUTING.md`:

```markdown
# Contributing

## Prerequisites

- Node.js 20+
- Docker & Docker Compose

## Local setup

```bash
# Install dependencies
npm install

# Start local services (MySQL, Redis, ElasticMQ)
docker compose up -d

# Copy environment template and fill in values
cp .env.example .env

# Run database migrations
npm run migration:run

# Seed demo data (optional)
npm run seed

# Start dev server with hot-reload
npm run dev
```

The API is available at `http://localhost:3000`.
Swagger UI at `http://localhost:3000/api-docs`.

## Running tests

```bash
npm test                    # all tests
npm run test:unit           # unit tests only
npm run test:integration    # integration tests (requires running Docker services)
npm run typecheck           # TypeScript type-check only
```

## Submitting a PR

1. Branch from `main`
2. Keep commits focused — use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`
3. Ensure `npm test` and `npm run typecheck` pass locally before opening a PR
4. Fill in the pull request template
```

- [ ] **Step 3: Create .github/PULL_REQUEST_TEMPLATE.md**

Create `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## What

<!-- Brief description of the change -->

## Why

<!-- Context: what problem does this solve or what goal does it serve? -->

## How

<!-- Summary of the approach taken -->

## Testing

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Tested manually (describe what you did)

## Checklist

- [ ] No `.env` or secrets committed
- [ ] No `console.log` left in production code
- [ ] Migration included if schema changed
```

- [ ] **Step 4: Verify files exist**

```bash
ls LICENSE CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md
```

Expected: all three paths printed without error.

- [ ] **Step 5: Commit**

```bash
git add LICENSE CONTRIBUTING.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "chore: add LICENSE (MIT), CONTRIBUTING.md, and PR template"
```

---

## Task 3: Fix two bugs in cd.yml

**Files:**
- Modify: `.github/workflows/cd.yml`

**Bug 1:** `${{ github.repository }}` resolves to `Alok650/project-management-platform` (capital A) but GHCR stores images lowercase. The SSH script uses it raw — `docker pull` would 404.

**Bug 2:** The migration `docker run` container isn't on the Compose network, so it can't resolve the `mysql` hostname from the `.env`.

- [ ] **Step 1: Rewrite the deploy job in cd.yml**

Replace the entire `deploy:` job (everything from `deploy:` to end of file) with:

```yaml
  # ── Deploy to production host via SSH ─────────────────────────────────────
  #
  # Requires secrets:
  #   DEPLOY_HOST    — SSH host (IP or domain)
  #   DEPLOY_USER    — SSH user (e.g. ubuntu)
  #   DEPLOY_SSH_KEY — private key (ed25519 or RSA)
  #   DEPLOY_DIR     — remote directory containing docker-compose.production.yml
  #
  deploy:
    name: Deploy to production
    runs-on: ubuntu-latest
    needs: publish
    environment: production   # use GitHub Environments for approval gates

    steps:
      - uses: actions/checkout@v4

      - name: Compute lowercase image name
        id: image
        run: echo "repo=$(echo '${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> $GITHUB_OUTPUT

      - name: Copy docker-compose.production.yml to server
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: docker-compose.production.yml,.env.example
          target: ${{ secrets.DEPLOY_DIR }}

      - name: Pull image + run migrations + restart service
        uses: appleboy/ssh-action@v1.0.3
        env:
          IMAGE_TAG: sha-${{ github.sha }}
          DEPLOY_DIR: ${{ secrets.DEPLOY_DIR }}
          REPO_LC: ${{ steps.image.outputs.repo }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GH_ACTOR: ${{ github.actor }}
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          envs: IMAGE_TAG,DEPLOY_DIR,REPO_LC,GH_TOKEN,GH_ACTOR
          script: |
            set -euo pipefail
            cd "$DEPLOY_DIR"

            # Pull the new image
            echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
            docker pull ghcr.io/$REPO_LC:$IMAGE_TAG

            # Run pending migrations before bringing up new containers
            # --network app_default connects this container to the Compose stack so
            # it can resolve the 'mysql' service hostname from .env
            docker run --rm --env-file .env \
              --network app_default \
              -e NODE_ENV=production \
              ghcr.io/$REPO_LC:$IMAGE_TAG \
              node -e "
                const { AppDataSource } = require('./dist/config/database');
                AppDataSource.initialize().then(() => AppDataSource.runMigrations()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
              "

            # Zero-downtime restart: bring up new container, let health-check pass, remove old
            APP_IMAGE=ghcr.io/$REPO_LC:$IMAGE_TAG \
              docker compose -f docker-compose.production.yml up -d --no-deps --wait app

            # Clean up dangling images
            docker image prune -f
```

- [ ] **Step 2: Verify the full cd.yml looks correct**

```bash
cat .github/workflows/cd.yml
```

Confirm: `REPO_LC` appears in the env block and in all three image references inside the SSH script. `--network app_default` is on the `docker run` migration line.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cd.yml
git commit -m "fix: lowercase image name and add compose network to migration in cd.yml"
```

---

## Task 4: Create GitHub repository

> **Note:** Do NOT push code yet — secrets (Task 5) and VM bootstrap (Task 6) must be complete first so the first CD run succeeds.

- [ ] **Step 1: Verify gh CLI is authenticated**

```bash
gh auth status
```

Expected: `Logged in to github.com as Alok650`. If not, run `gh auth login` first.

- [ ] **Step 2: Create the public repo**

```bash
gh repo create Alok650/project-management-platform \
  --public \
  --description "A product management platform built with Node.js, TypeScript, and Koa"
```

Expected output includes: `✓ Created repository Alok650/project-management-platform on GitHub`

- [ ] **Step 3: Add remote and verify**

```bash
git remote add origin https://github.com/Alok650/project-management-platform.git
git remote -v
```

Expected:
```
origin  https://github.com/Alok650/project-management-platform.git (fetch)
origin  https://github.com/Alok650/project-management-platform.git (push)
```

---

## Task 5: Configure GitHub Secrets and Production Environment

- [ ] **Step 1: Set DEPLOY_HOST**

```bash
gh secret set DEPLOY_HOST --body "140.245.216.53" --repo Alok650/project-management-platform
```

Expected: `✓ Set Actions secret DEPLOY_HOST for Alok650/project-management-platform`

- [ ] **Step 2: Set DEPLOY_USER**

```bash
gh secret set DEPLOY_USER --body "ubuntu" --repo Alok650/project-management-platform
```

- [ ] **Step 3: Set DEPLOY_SSH_KEY**

```bash
gh secret set DEPLOY_SSH_KEY --repo Alok650/project-management-platform < ~/Downloads/oracle_vm.key
```

- [ ] **Step 4: Set DEPLOY_DIR**

```bash
gh secret set DEPLOY_DIR --body "/home/ubuntu/app" --repo Alok650/project-management-platform
```

- [ ] **Step 5: Create the production GitHub Environment**

```bash
gh api repos/Alok650/project-management-platform/environments/production \
  -X PUT \
  -f wait_timer=0
```

Expected: JSON response containing `"name":"production"`.

- [ ] **Step 6: Verify all secrets are listed**

```bash
gh secret list --repo Alok650/project-management-platform
```

Expected: four secrets — `DEPLOY_DIR`, `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_USER`.

---

## Task 6: Bootstrap the VM

All commands in this task run on the VM via SSH. Prefix each with:
```bash
ssh -i ~/Downloads/oracle_vm.key ubuntu@140.245.216.53
```
Or open an interactive session for the duration of this task.

- [ ] **Step 1: Create the deploy directory**

```bash
mkdir -p /home/ubuntu/app
```

- [ ] **Step 2: Install Nginx**

```bash
sudo apt-get update -qq && sudo apt-get install -y nginx
sudo systemctl enable nginx
```

Expected: `nginx` package installed, `Created symlink … nginx.service`.

- [ ] **Step 3: Write Nginx site config**

```bash
sudo tee /etc/nginx/sites-available/pmp > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF
```

- [ ] **Step 4: Enable the site and remove the default**

```bash
sudo ln -sf /etc/nginx/sites-available/pmp /etc/nginx/sites-enabled/pmp
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`

- [ ] **Step 5: Configure ufw firewall**

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

Expected `ufw status` output includes:
```
22/tcp    ALLOW
80/tcp    ALLOW
443/tcp   ALLOW
```

- [ ] **Step 6: Open port 80 in Oracle Cloud VCN (manual — OCI Console)**

This step cannot be done via SSH — it requires the Oracle Cloud web console:

1. Log in to console.oracle.com
2. Navigate to **Networking → Virtual Cloud Networks → your VCN**
3. Click **Security Lists → Default Security List**
4. Click **Add Ingress Rules**
5. Set: Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port `80`
6. Save

Without this step, port 80 is blocked at the cloud perimeter even though ufw allows it.

- [ ] **Step 7: Create .env on the VM**

```bash
cat > /home/ubuntu/app/.env <<'EOF'
NODE_ENV=production
PORT=3000
DB_HOST=mysql
DB_PORT=3306
DB_NAME=pmp
DB_USER=pmp
DB_PASSWORD=CHANGE_ME
DB_ROOT_PASSWORD=CHANGE_ME_ROOT
DB_POOL_MAX=50
REDIS_URL=redis://redis:6379
JWT_SECRET=CHANGE_ME_32_CHARS_MIN
JWT_EXPIRES_IN=7d
AWS_REGION=us-east-1
AWS_ENDPOINT=
AWS_ACCESS_KEY_ID=x
AWS_SECRET_ACCESS_KEY=x
SQS_NOTIFICATION_QUEUE_URL=
LOG_LEVEL=info
EOF
```

Then edit it to replace the `CHANGE_ME` placeholders:

```bash
# Generate secure values
openssl rand -hex 16   # use for DB_PASSWORD
openssl rand -hex 16   # use for DB_ROOT_PASSWORD
openssl rand -hex 32   # use for JWT_SECRET

nano /home/ubuntu/app/.env
```

> **Important:** `DB_HOST=mysql` and `REDIS_URL=redis://redis:6379` use Docker Compose service names — do not change these to `localhost`.

- [ ] **Step 8: Copy docker-compose.production.yml to VM**

Run this from your **local machine** (not the VM):

```bash
scp -i ~/Downloads/oracle_vm.key \
  docker-compose.production.yml \
  ubuntu@140.245.216.53:/home/ubuntu/app/
```

- [ ] **Step 9: Pre-start MySQL and Redis so the Compose network exists before first CD run**

On the VM:

```bash
cd /home/ubuntu/app
docker compose -f docker-compose.production.yml up -d mysql redis
```

- [ ] **Step 10: Wait for MySQL to be healthy**

```bash
docker compose -f docker-compose.production.yml ps
```

Re-run until `mysql` shows `healthy` (takes ~30–60 seconds on first start). The `app_default` Docker network now exists.

---

## Task 7: Push code to GitHub — triggers first CI + CD run

- [ ] **Step 1: Push from local machine**

```bash
git push -u origin main
```

Expected: objects counted and pushed, ending with `Branch 'main' set up to track remote branch 'main' of 'origin'`.

- [ ] **Step 2: Watch CI run pass**

```bash
gh run watch --repo Alok650/project-management-platform
```

Select the most recent run. Wait for `CI` job to show ✓ (typecheck + tests + docker build — ~3–5 minutes).

- [ ] **Step 3: Watch CD run deploy**

After CI passes, CD triggers automatically. Keep watching, or:

```bash
gh run list --repo Alok650/project-management-platform
```

The `CD` run should show `publish` then `deploy` jobs completing (total ~4–7 minutes including image build and push).

---

## Task 8: Verify end-to-end

- [ ] **Step 1: Hit the health endpoint via public IP**

```bash
curl -s http://140.245.216.53/api/health/live
```

Expected response:
```json
{"status":"ok"}
```

- [ ] **Step 2: Check app container is running on VM**

```bash
ssh -i ~/Downloads/oracle_vm.key ubuntu@140.245.216.53 \
  "docker compose -f /home/ubuntu/app/docker-compose.production.yml ps"
```

Expected: `app`, `mysql`, and `redis` all show `running (healthy)`.

- [ ] **Step 3: Check Nginx is proxying correctly**

```bash
ssh -i ~/Downloads/oracle_vm.key ubuntu@140.245.216.53 \
  "sudo nginx -t && sudo systemctl status nginx --no-pager"
```

Expected: `active (running)`.

- [ ] **Step 4: Smoke-test the login endpoint**

```bash
curl -s -X POST http://140.245.216.53/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.com","password":"password123"}' | jq .
```

Expected: JSON response with `token` field (seed data was loaded during first deploy migrations — or run seed manually if needed).

> If seed data isn't present, SSH into the VM and run:
> ```bash
> docker run --rm --env-file /home/ubuntu/app/.env \
>   --network app_default \
>   ghcr.io/alok650/project-management-platform:latest \
>   node -e "require('./dist/seeds/seed').seed ? require('./dist/seeds/seed').seed() : require('./dist/seeds/seed').default()"
> ```

- [ ] **Step 5: Verify the GitHub repo is public and clean**

Open `https://github.com/Alok650/project-management-platform` in a browser. Confirm:
- `docs/SCALING.md` and `docs/specs.md` are **not** present
- `docs/adr/` has 4 ADR files
- `LICENSE`, `CONTRIBUTING.md` are present
- `.github/workflows/` shows `ci.yml` and `cd.yml`
- No `.env` file visible

---

## Self-Review

**Spec coverage:**
- ✅ Repo cleanup (delete planning docs, update .gitignore) — Task 1
- ✅ Standard OSS files (LICENSE, CONTRIBUTING, PR template) — Task 2
- ✅ Fix cd.yml bug 1: lowercase image name — Task 3
- ✅ Fix cd.yml bug 2: migration network — Task 3
- ✅ GitHub repo creation — Task 4
- ✅ GitHub Secrets + production environment — Task 5
- ✅ VM bootstrap (Nginx, ufw, .env, MySQL+Redis pre-start) — Task 6
- ✅ OCI console firewall rule — Task 6 Step 6
- ✅ Push + first CD run — Task 7
- ✅ End-to-end verification — Task 8

**Placeholder scan:** No TBDs. All commands include exact values. `.env` placeholders are intentional and instruct the engineer to generate real values.

**Type consistency:** No shared types — this is infra/config work.
