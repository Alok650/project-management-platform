# Product Management Platform

A Jira-like project management platform. Supports projects, sprints, issues with workflow transitions, threaded comments, real-time board updates via WebSocket, and an activity feed — all backed by a hexagonal, event-driven architecture.

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 18+ |
| Language | TypeScript | 5.6 |
| HTTP Framework | Koa.js | 2.15 |
| ORM | TypeORM | 0.3 |
| Database | MySQL | 8 |
| Cache / Pub-Sub | Redis (ioredis) | 7 / 5.4 |
| Queue | AWS SQS / ElasticMQ | SDK v3 |
| Real-time | ws (WebSocket) | 8.18 |
| Validation | Joi | 17 |
| Auth | jsonwebtoken + bcryptjs | 9 / 2.4 |
| Logging | pino | 9 |
| Metrics | prom-client | 15 |
| API Docs | swagger-jsdoc + koa2-swagger-ui | 6 / 5 |

---

## Architecture

The service uses **hexagonal architecture** (ports and adapters). Each module follows a strict layering convention:

```
routes → controller → manager (optional) → service → repository
```

Business logic lives exclusively in the service layer and depends on repository interfaces (ports), not concrete implementations. TypeORM repositories are the adapters.

**Cross-cutting patterns:**

- **CQRS** — the Issues module separates `IssueCommandService` (writes, optimistic locking) from `IssueQueryService` (reads, Redis board cache). See [ADR-002](docs/adr/ADR-002-cqrs-for-issues.md).
- **Domain Events / Observer** — an in-process typed `EventBus` decouples write paths from side-effects. `ActivityService` and `NotificationService` subscribe to events; publishers never call them directly. See [ADR-003](docs/adr/ADR-003-event-driven-activity.md).
- **Repository** — each module owns a TypeORM repository class that implements a typed interface, keeping the service layer infrastructure-agnostic.
- **Strategy** — workflow transition rules are encapsulated as swappable strategy objects per issue type/status.
- **Chain of Responsibility** — Koa middleware pipeline (correlation ID → error handler → request logger → metrics → rate limiter → helmet → CORS → body parser → routes).
- **Circuit Breaker** — wraps outbound notification delivery; state stored in Redis so all pods share it.
- **Factory** — `createApp()` in `src/app.ts` is a factory that assembles the Koa application, keeping bootstrap logic out of the module scope.

For a full rationale on key decisions, see the [Architecture Decision Records](docs/adr/).

---

## Prerequisites

- **Node.js** 18+
- **Docker** and **Docker Compose** (for MySQL, Redis, ElasticMQ)

---

## Quick Start

```bash
# 1. Copy environment config
cp .env.example .env

# 2. Start infrastructure (MySQL, Redis, ElasticMQ)
docker compose up -d

# 3. Install dependencies
npm install

# 4. Run database migrations
npm run migration:run

# 5. Seed initial data (roles, default statuses, demo project)
npm run seed

# 6. Start the development server (hot-reload)
npm run dev
```

The API is available at `http://localhost:3000`.
Interactive API docs (Swagger UI) are at `http://localhost:3000/docs`.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Runtime environment (`development`, `production`, `test`) | `development` |
| `DB_HOST` | MySQL host | `localhost` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL username | `root` |
| `DB_PASS` | MySQL password | `password` |
| `DB_NAME` | MySQL database name | `pm_platform` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `SQS_ENDPOINT` | SQS / ElasticMQ endpoint URL | `http://localhost:9324` |
| `SQS_QUEUE_URL` | Full URL of the notification queue | `http://localhost:9324/000000000000/notifications` |
| `JWT_SECRET` | Secret used to sign JWTs | *(required)* |
| `JWT_EXPIRES_IN` | JWT expiry duration (e.g. `7d`) | `7d` |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit sliding window in milliseconds | `60000` |
| `RATE_LIMIT_MAX` | Max requests per window per IP | `100` |
| `BOARD_CACHE_TTL_SECS` | Redis TTL for board state cache | `30` |
| `LOG_LEVEL` | pino log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |

---

## API Endpoints

All REST endpoints are prefixed with `/api/v1`. Full request/response schemas are available in Swagger UI at `/docs`.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Register a new user |
| `POST` | `/api/v1/auth/login` | Obtain a JWT |
| `POST` | `/api/v1/auth/logout` | Revoke the current JWT (blacklists JTI in Redis) |

### Projects

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/projects` | Create a project |
| `GET` | `/api/v1/projects` | List projects for the authenticated user |
| `GET` | `/api/v1/projects/:id` | Get a single project |
| `PUT` | `/api/v1/projects/:id` | Update project details |
| `DELETE` | `/api/v1/projects/:id` | Delete a project |
| `POST` | `/api/v1/projects/:id/members` | Add a member to a project |
| `DELETE` | `/api/v1/projects/:id/members/:userId` | Remove a member |

### Issues

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/projects/:projectId/issues` | Create an issue |
| `GET` | `/api/v1/projects/:projectId/issues` | List issues (filterable) |
| `GET` | `/api/v1/projects/:projectId/issues/:id` | Get a single issue |
| `PUT` | `/api/v1/projects/:projectId/issues/:id` | Update an issue |
| `DELETE` | `/api/v1/projects/:projectId/issues/:id` | Delete an issue |
| `POST` | `/api/v1/projects/:projectId/issues/:id/transition` | Transition issue status |
| `POST` | `/api/v1/projects/:projectId/issues/:id/watchers` | Add a watcher |
| `DELETE` | `/api/v1/projects/:projectId/issues/:id/watchers/:userId` | Remove a watcher |
| `GET` | `/api/v1/projects/:projectId/board` | Board view (Redis-cached, CQRS read path) |

### Sprints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/projects/:projectId/sprints` | Create a sprint |
| `GET` | `/api/v1/projects/:projectId/sprints` | List sprints |
| `GET` | `/api/v1/projects/:projectId/sprints/:id` | Get a sprint |
| `PUT` | `/api/v1/projects/:projectId/sprints/:id` | Update a sprint |
| `DELETE` | `/api/v1/projects/:projectId/sprints/:id` | Delete a sprint |
| `POST` | `/api/v1/projects/:projectId/sprints/:id/start` | Start a sprint |
| `POST` | `/api/v1/projects/:projectId/sprints/:id/complete` | Complete a sprint |

### Comments

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/issues/:issueId/comments` | Create a comment (supports `parentId` for threading) |
| `GET` | `/api/v1/issues/:issueId/comments` | List comments (threaded) |
| `PUT` | `/api/v1/issues/:issueId/comments/:id` | Edit a comment |
| `DELETE` | `/api/v1/issues/:issueId/comments/:id` | Delete a comment |

### Search

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/projects/:id/search` | Full-text search over issues and comments within a project |

### Activity

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/projects/:id/activity` | Paginated activity feed for a project |

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health/live` | Liveness probe — returns 200 if process is alive |
| `GET` | `/api/health/ready` | Readiness probe — checks MySQL + Redis connectivity |
| `GET` | `/api/health/metrics` | Prometheus metrics endpoint |

### WebSocket

```
ws://localhost:3000/ws?projectId=<id>&userId=<id>
```

Clients subscribe to a project channel and receive real-time push events when issues are created, updated, or transitioned. Authentication is via a `token` query parameter (JWT).

---

## Key Design Decisions

Detailed rationale for each major architectural choice is recorded in the [Architecture Decision Records](docs/adr/):

| ADR | Decision |
|---|---|
| [ADR-001](docs/adr/ADR-001-hexagonal-architecture.md) | Hexagonal architecture — routes → controller → service → repository |
| [ADR-002](docs/adr/ADR-002-cqrs-for-issues.md) | CQRS for Issues — separate command and query services |
| [ADR-003](docs/adr/ADR-003-event-driven-activity.md) | Domain events for activity feed and notifications |
| [ADR-004](docs/adr/ADR-004-redis-board-cache.md) | Redis board state cache with 30s TTL |

---

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration
```

Integration tests require the infrastructure containers to be running (`docker compose up -d`).

---

## Load Testing

A k6 load test script targeting the board view endpoint is included:

```bash
k6 run load-tests/board-view.js
```

The script simulates 100 virtual users continuously loading the board view to validate cache effectiveness and latency under concurrent read load.

---

## Horizontal Scaling

This service is designed to scale horizontally. All HTTP pods are stateless; shared state lives in MySQL and Redis. For guidance on scaling the Redis cache, WebSocket broadcast layer, MySQL read replicas, SQS consumers, and Prometheus metrics aggregation, see [docs/SCALING.md](docs/SCALING.md).
