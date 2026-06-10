# Design: CD Pipeline, GitHub Repository & VM Deployment

**Date:** 2026-06-11  
**Status:** Approved

---

## Goal

Ship a clean public GitHub repository and a reliable continuous deployment pipeline so that every push to `main` automatically deploys to the Oracle VM at `140.245.216.53` and is accessible at `http://140.245.216.53`.

---

## Section 1 — Repository Cleanup

### Files kept

| Path | Reason |
|------|--------|
| `src/` | Application source |
| `tests/` | Test suite |
| `docs/adr/` | Architecture Decision Records (4 ADRs) |
| `postman/` | API collection for manual testing |
| `load-tests/` | K6 load test scripts |
| `.github/` | CI/CD workflows |
| `Dockerfile` | Multi-stage production image |
| `docker-compose.yml` | Local dev stack |
| `docker-compose.production.yml` | Production stack (app + MySQL + Redis) |
| `package*.json` | Node.js manifest and lockfile |
| `tsconfig.json` | TypeScript config |
| `jest.config.ts` | Test config |
| `elasticmq.conf` | Local SQS emulator config |
| `.env.example` | Environment variable template |
| `README.md` | Project documentation |

### Files deleted locally + gitignored

| Path | Reason |
|------|--------|
| `docs/SCALING.md` | Internal planning artifact |
| `docs/specs.md` | Internal planning artifact |
| `docs/superpowers/` | Internal AI planning docs |

### `.gitignore` additions

```
docs/SCALING.md
docs/specs.md
docs/superpowers/
*.tsbuildinfo
.DS_Store
```

### Standard OSS files to add

| File | Content |
|------|---------|
| `LICENSE` | MIT licence |
| `CONTRIBUTING.md` | How to run locally, run tests, submit PRs |
| `.github/PULL_REQUEST_TEMPLATE.md` | Consistent PR description template |

---

## Section 2 — GitHub Repository

- **Repo:** `github.com/Alok650/project-management-platform` (public)
- **GHCR image:** `ghcr.io/alok650/project-management-platform`
- **Secrets** (set in repo Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | `140.245.216.53` |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_SSH_KEY` | Contents of `~/Downloads/oracle_vm.key` |
| `DEPLOY_DIR` | `/home/ubuntu/app` |

- No changes to existing `ci.yml` or `cd.yml` — they are production-ready.
- The `cd.yml` already references `environment: production`; create a GitHub Environment named `production` (no approval gate required for now).

---

## Section 3 — VM Bootstrap

Performed once manually before CD takes over.

1. **Create deploy directory:** `/home/ubuntu/app`
2. **Install Nginx** via `apt`, configure as systemd service.
3. **Nginx config** — proxy `http://140.245.216.53` (port 80) → `localhost:3000`. No SSL (no domain). Config placed at `/etc/nginx/sites-available/pmp`.
4. **Open firewall ports** on the VM host (Ubuntu `ufw`): allow 22 (SSH), 80 (HTTP), 443 (HTTPS for future).
5. **Oracle Cloud ingress rules:** open port 80 in the VCN security list (port 3000 stays closed externally — only Nginx talks to it).
6. **Create `.env`** at `/home/ubuntu/app/.env` from `.env.example` with real production values.
7. **First manual deploy:** pull image from GHCR, run migrations, `docker compose -f docker-compose.production.yml up -d`.
8. **Verify:** `curl http://140.245.216.53/api/health/live` returns `200`.

---

## Section 4 — CD Flow End-to-End

```
git push main
    │
    ├─► CI job (ci.yml)
    │       typecheck → tests → docker build check
    │
    └─► CD job (cd.yml) — only on main
            │
            ├─ publish: build + push ghcr.io/alok650/project-management-platform:sha-<sha>
            │
            └─ deploy (needs: publish)
                    SSH → VM
                    docker pull <new image>
                    run migrations
                    docker compose up -d --no-deps --wait app
                    docker image prune -f
```

- **Concurrency:** `cancel-in-progress: false` — queues deploys, never cancels one mid-flight.
- **Zero-downtime:** `--wait` flag waits for health-check to pass before old container is removed.
- **Rollback:** re-run a previous workflow run via `workflow_dispatch` with an older SHA tag.

---

## Out of Scope

- SSL/TLS (no domain name available yet — add later with Let's Encrypt once a domain is attached)
- GitHub Environment approval gates (can be added when team grows)
- Staging environment
