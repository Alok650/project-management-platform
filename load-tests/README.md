# Load Tests

Four k6 scenarios covering different aspects of system behaviour.

## Prerequisites

```bash
brew install k6        # macOS
# or: https://k6.io/docs/getting-started/installation/
```

## Setup — start the server and seed data

```bash
# Terminal 1 — start the app
docker compose up -d
npm run migration:run
npm run seed
npm run dev
```

Grab a JWT token and IDs from the running server:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo.com","password":"password123"}' \
  | jq -r '.data.token')

PROJECT_ID=$(curl -s http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.items[0].id')

SPRINT_ID=$(curl -s http://localhost:3000/api/v1/projects/$PROJECT_ID/sprints \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | select(.status=="ACTIVE") | .id')

ISSUE_ID=$(curl -s "http://localhost:3000/api/v1/projects/$PROJECT_ID/issues?limit=1" \
  -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.items[0].id')
```

---

## Scenarios

### 1. Board view — 100 concurrent readers + 15% writers

The primary SLO test. 100 VUs: 85% read the board (Redis cache), 15% create issues
(forcing cache invalidation). Validates throughput under mixed load.

```bash
K6_BASE_URL=http://localhost:3000 \
K6_PROJECT_ID=$PROJECT_ID \
K6_SPRINT_ID=$SPRINT_ID \
K6_SEED_EMAIL=admin@demo.com \
K6_SEED_PASSWORD=password123 \
k6 run load-tests/board-view.js
```

**Thresholds:** p95 < 500ms · error rate < 1% · p99 < 1s

---

### 2. Concurrent updates — optimistic locking under contention

10 VUs race to update the same issue with the same version. Validates that
`@VersionColumn` produces 409s (not silent data loss or 500s).

```bash
K6_BASE_URL=http://localhost:3000 \
K6_ISSUE_ID=$ISSUE_ID \
K6_ISSUE_VERSION=1 \
K6_SEED_EMAIL=admin@demo.com \
K6_SEED_PASSWORD=password123 \
k6 run load-tests/concurrent-updates.js
```

**Expected:** ~90% conflict rate (409), zero 500s, at least a few successful writes.

---

### 3. Spike test — rate limiter validation

Ramps to 200 VUs in 15s to trigger the Redis sliding-window rate limiter (100 req/min/IP).
Checks the server returns 429 + `Retry-After` header and never 500s.

```bash
K6_BASE_URL=http://localhost:3000 \
K6_PROJECT_ID=$PROJECT_ID \
K6_SEED_EMAIL=admin@demo.com \
K6_SEED_PASSWORD=password123 \
k6 run load-tests/spike-test.js
```

**Thresholds:** zero 5xx errors.

---

### 4. User journey — realistic mixed workload

50 VUs each run a 6-step journey: view board → open issue → create issue →
transition status → add comment with @mention → search. Most representative
test for overall system health.

```bash
K6_BASE_URL=http://localhost:3000 \
K6_PROJECT_ID=$PROJECT_ID \
K6_SPRINT_ID=$SPRINT_ID \
K6_SEED_EMAIL=admin@demo.com \
K6_SEED_PASSWORD=password123 \
k6 run load-tests/user-journey.js
```

**Thresholds:** p95 step duration < 1s · journey error rate < 5%.

---

## Running all scenarios

```bash
export K6_BASE_URL=http://localhost:3000
export K6_PROJECT_ID=$PROJECT_ID
export K6_SPRINT_ID=$SPRINT_ID
export K6_ISSUE_ID=$ISSUE_ID
export K6_SEED_EMAIL=admin@demo.com
export K6_SEED_PASSWORD=password123

k6 run load-tests/board-view.js       && \
k6 run load-tests/concurrent-updates.js && \
k6 run load-tests/spike-test.js       && \
k6 run load-tests/user-journey.js
```
