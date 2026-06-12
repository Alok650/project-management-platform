# Project Architecture & Request Lifecycle

## What You'll Learn

- What Hexagonal Architecture (Ports & Adapters) is, why it was chosen for this codebase, and how it differs from traditional layered MVC
- How Koa.js's middleware "onion model" works and why it is fundamentally different from Express's linear pipeline
- What the Chain of Responsibility pattern is and how every middleware in this project implements it
- What correlation IDs are, how they are propagated through `AsyncLocalStorage`, and why they are non-negotiable in distributed systems
- How errors propagate up the Koa middleware stack and why `errorHandler` lives at position two, not last
- The exact call chain for every HTTP request — from TCP packet arrival to JSON bytes on the wire
- The `AppError` class hierarchy and how each subclass maps to an HTTP status code
- The `ApiResponse` shape and why a uniform response envelope prevents client-side guesswork

---

## Part 1 — Theory

### 1.1 Hexagonal Architecture (Ports & Adapters)

#### The Problem with Layered Architecture

Classic MVC or three-tier layered architecture draws the dependency arrow in one direction: Controller → Service → Repository → Database. This is an improvement over spaghetti code, but it has a subtle, expensive flaw: **the business logic layer knows about the infrastructure layer**. The `UserService` imports `UserRepository`, which imports TypeORM, which assumes a specific database wire protocol. When you want to unit-test `UserService`, you must either spin up a real database or write fragile mocks of TypeORM internals.

There is a second problem: infrastructure leaks upward. A TypeORM `QueryFailedError` thrown by the repository can surface unchanged in the HTTP controller if no one catches it. The database vendor becomes an implicit dependency of your entire stack.

#### The Hexagonal Solution

Alistair Cockburn coined the term "hexagonal architecture" in 2005. The insight is deceptively simple: **the business logic should not depend on infrastructure; instead, infrastructure should depend on business logic**.

The mechanism is a *port* — a plain TypeScript interface that describes what the business logic needs — and an *adapter* — a concrete class that implements that interface using real infrastructure.

```
          ┌──────────────────────────────────┐
          │          Application Core         │
          │                                  │
  HTTP  ──►  Controller → Service            │
 (adapter)│               │                  │
          │               ▼                  │
          │          IRepository  (PORT)      │
          │                                  │
          └────────────────▲─────────────────┘
                           │
                    TypeORMRepository  (ADAPTER)
                           │
                        MySQL
```

The service only ever calls methods on `IRepository`. At runtime you inject `TypeORMRepository`; in tests you inject `InMemoryRepository`. The service code never changes.

#### Why It Was Chosen Here

From `docs/adr/ADR-001-hexagonal-architecture.md`:

> Early-stage projects frequently swap persistence backends (e.g. MySQL to Postgres), caching layers (Redis to Memcached), or queue providers (SQS to RabbitMQ). Without explicit layer boundaries, infrastructure concerns bleed into business logic, making such changes costly and risky.

The ADR also notes the second driver: **fast, isolated unit tests**. Because services depend on repository interfaces, not TypeORM classes, any test can supply a plain object that satisfies the interface.

#### Module Layout in This Codebase

Every feature module under `src/modules/<module>/` follows this exact vertical slice:

```
src/modules/issues/
├── routes/v1/issueRoutes.ts      ← HTTP adapter (Koa Router)
├── IssueController.ts            ← Orchestration; calls IssueManager
├── IssueManager.ts               ← Optional composition layer for multi-step workflows
├── IssueCommandService.ts        ← Write-side business logic
├── IssueQueryService.ts          ← Read-side business logic
├── IssueRepository.ts            ← TypeORM adapter (implements repository port)
├── interfaces.ts                 ← Port definitions (repository interfaces)
├── constants.ts                  ← Enum-free string constants for this domain
└── schemas/issueSchemas.ts       ← Joi validation schemas (HTTP boundary)
```

The flow is always: `routes → controller → (optional manager) → service → repository`. No layer may skip a level; no layer may call a sibling module's service directly. Cross-module side-effects travel through the in-process `EventBus`.

Shared plumbing that no single module owns lives in three other top-level directories:

| Directory | Purpose |
|---|---|
| `src/config/` | Validated env vars, database connection, Redis client |
| `src/core/` | Middleware, error classes, shared types, validation utilities |
| `src/infrastructure/` | Logger, metrics, caching abstractions, EventBus |

---

### 1.2 The Koa.js Middleware Onion Model

#### Express: Linear Pipeline

In Express, `next()` passes control forward. Each middleware calls `next()` once to hand off to the next handler and then stops. There is no "after" phase unless you use `res.on('finish', ...)` hooks.

```javascript
// Express — linear, one-directional
app.use((req, res, next) => {
  console.log('before A');
  next();
  // code here runs *after* next() returns, but only if this handler is still on the call stack
  // In practice, Express handlers rarely do useful work after next()
});
```

#### Koa: Onion Model

Koa is built on `async/await` throughout. Every middleware is an `async (ctx, next) => {}` function. When you `await next()`, you suspend the current middleware, pass control inward to the next layer, and **resume exactly where you left off** after all inner layers have completed. This creates a symmetrical "before / after" execution model:

```
Request enters →
  [Middleware 1 - before]
    [Middleware 2 - before]
      [Middleware 3 - before]
        [Route handler]
      [Middleware 3 - after]  ← resumes here after route handler
    [Middleware 2 - after]
  [Middleware 1 - after]
← Response exits
```

Visually, this is an onion: each layer wraps all inner layers completely.

```
┌─────────────────────────────────────────────────┐
│  errorHandler                                   │
│  ┌───────────────────────────────────────────┐  │
│  │  requestLogger                            │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  metricsMiddleware                  │  │  │
│  │  │  ┌───────────────────────────────┐  │  │  │
│  │  │  │  rateLimiter                  │  │  │  │
│  │  │  │  ┌─────────────────────────┐  │  │  │  │
│  │  │  │  │  helmet / cors / body   │  │  │  │  │
│  │  │  │  │  ┌───────────────────┐  │  │  │  │  │
│  │  │  │  │  │   Route Handler   │  │  │  │  │  │
│  │  │  │  │  └───────────────────┘  │  │  │  │  │
│  │  │  │  └─────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

The practical consequence: `requestLogger` records the response status **after** the route handler has run, simply by placing its logging call after `await next()`. No callbacks, no finish events.

---

### 1.3 Chain of Responsibility Pattern

The Chain of Responsibility is a Gang of Four behavioural pattern. You have a sequence of handlers. A request travels down the chain; each handler decides whether to process it, modify it, and/or pass it onward.

Pseudocode:

```typescript
class Handler {
  next: Handler | null = null;

  handle(request: Request): Response {
    if (this.canHandle(request)) {
      return this.process(request);
    }
    if (this.next) {
      return this.next.handle(request);
    }
    throw new Error('No handler found');
  }
}
```

Koa's middleware pipeline is Chain of Responsibility implemented with closures and `async/await`. Instead of `this.next.handle(request)`, you call `await next()`. The "chain" is the ordered list of `app.use()` calls. Each middleware is a link.

The key properties that hold in both the classic pattern and Koa:

1. **A handler can short-circuit the chain** — returning early without calling `next()` means no downstream middleware runs. The rate limiter does this when the limit is exceeded.
2. **A handler can enrich the request context** — the correlation ID middleware adds `ctx.state.correlationId` before passing control down.
3. **A handler can inspect the response** — after `await next()`, any middleware can read and modify the response that inner layers produced.

---

### 1.4 Correlation IDs in Distributed Systems

Imagine a user reports: "my request failed with `INTERNAL_ERROR`". You open your logs. There are ten thousand log lines per second across three service replicas. Which lines belong to that specific request?

A correlation ID is a UUID attached to one request at its entry point and threaded through every log line, outbound HTTP call, and queue message that originates from that request. When you filter logs by `correlationId = "b3a1..."`, you see exactly the causal chain for that request — nothing more, nothing less.

#### The `AsyncLocalStorage` Trick

Node.js is single-threaded but handles thousands of concurrent requests. You cannot store per-request data in a module-level variable because all requests share the same module scope. You could pass the correlation ID as a function argument through every layer, but that pollutes every function signature.

`AsyncLocalStorage` (part of Node's `async_hooks` module) solves this. It is a context object that is automatically propagated across all `await` chains that originate from the same `run()` call. Think of it as a thread-local variable, but for async chains.

```typescript
// Anywhere in the codebase — no arguments needed
import { correlationStore } from '../middleware/correlationId';

function someDeepServiceMethod() {
  const id = correlationStore.getStore(); // returns the ID for the current request
  logger.info({ correlationId: id }, 'doing work');
}
```

This is exactly how this project implements it (see `src/core/middleware/correlationId.ts`, line 5 and 12):

```typescript
export const correlationStore = new AsyncLocalStorage<string>();

export const correlationId: Middleware = async (ctx, next) => {
  const id = (ctx.headers['x-correlation-id'] as string) ?? randomUUID();
  ctx.state.correlationId = id;
  ctx.set('X-Correlation-ID', id);
  await correlationStore.run(id, next);  // every await inside next() inherits this store value
};
```

By wrapping `next` inside `correlationStore.run(id, next)`, every middleware and service called downstream — for the lifetime of this request — can call `correlationStore.getStore()` and get the same ID. The ID is also set as a response header so the client can include it in bug reports.

---

### 1.5 Centralised, Structured Error Handling

Without a central error handler, each route handler must individually catch errors, decide on an HTTP status, and format a response. Three problems emerge:

1. **Inconsistent shapes**: one route returns `{ error: "not found" }`, another returns `{ message: "User not found", status: 404 }`. API clients cannot write a single error-handling utility.
2. **Duplicate logic**: every handler repeats the same `try/catch` boilerplate.
3. **Sensitive information leaks**: a raw `QueryFailedError` from TypeORM contains SQL strings and internal stack details. Without a central filter, these can reach the client.

The solution: define a typed error hierarchy that carries HTTP metadata, throw from anywhere in the stack, and catch once in a single middleware that owns the translation to HTTP.

---

## Part 2 — Implementation Walkthrough

### 2.1 Bootstrap Sequence (`src/server.ts`)

Before a single HTTP request arrives, `bootstrap()` runs the following sequence:

```typescript
// src/server.ts — bootstrap()
await AppDataSource.initialize();          // 1. Connect to MySQL via TypeORM

new ActivityService(new ActivityRepository()); // 2. Register domain event subscriptions
new NotificationService();                    //    (side-effect: subscribes to EventBus)

sqsConsumer?.start();                      // 3. Start polling SQS (if queue URL configured)

await redis.connect();                     // 4. Connect to Redis

const app = createApp();                   // 5. Build the Koa application (see §2.2)
const httpServer = createServer(app.callback()); // 6. Wrap in Node http.Server

const wsService = new WebSocketService(httpServer); // 7. Attach WebSocket server

httpServer.listen(env.PORT);               // 8. Bind to TCP port
```

Steps 2 and 3 are important: `ActivityService` and `NotificationService` are instantiated purely to trigger their constructor side-effects — subscribing to the in-process `EventBus`. If you comment out these lines, activity logs and notifications silently stop working even though the HTTP layer is fully functional.

#### Graceful Shutdown

The shutdown sequence (lines 61–81 of `src/server.ts`) is carefully ordered. It stops accepting new connections first, then drains in-flight requests with a 30-second hard timeout (`SHUTDOWN_DRAIN_TIMEOUT_MS`), then tears down WebSocket connections, then the database pool, then Redis — in reverse dependency order. This prevents race conditions where a request finishes its HTTP leg but its database transaction is already gone.

#### Environment Validation (`src/config/env.ts`)

The very first thing the server does at module import time is validate all environment variables:

```typescript
// src/config/env.ts
const schema = Joi.object<Env>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),
  JWT_SECRET: Joi.string().min(32).required(),
  // ... all variables declared and typed
}).unknown(true);

const { error, value } = schema.validate(process.env);
if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}
export const env = value as Env;
```

If `JWT_SECRET` is missing, the process crashes at import time with a clear message — not during the first login request at 2am. This is "fail-fast" configuration management. The `min(32)` constraint also prevents developers accidentally setting a weak secret in production.

---

### 2.2 `createApp()` — Middleware Registration in Order

`src/app.ts` exports a single factory function. The order of `app.use()` calls is the onion layer order. Here is the full chain with the reasoning for each position:

```typescript
export const createApp = (): Koa => {
  const app = new Koa();

  app.use(correlationId);     // Layer 1 — outermost
  app.use(errorHandler);      // Layer 2
  app.use(requestLogger);     // Layer 3
  app.use(metricsMiddleware);  // Layer 4
  app.use(rateLimiter);       // Layer 5
  app.use(helmet(...));       // Layer 6
  app.use(cors(...));         // Layer 7
  app.use(bodyParser(...));   // Layer 8
  // swagger/spec handlers    // Layer 9
  app.use(apiRouter.routes()); // Layer 10 — innermost
  // ...
};
```

#### Layer 1 — `correlationId` (`src/core/middleware/correlationId.ts`)

Position: outermost. Reason: every subsequent middleware, log line, and error message needs the correlation ID. If it were placed after `errorHandler`, errors thrown before the ID is set would have no ID attached.

```typescript
export const correlationId: Middleware = async (ctx, next) => {
  const id = (ctx.headers['x-correlation-id'] as string) ?? randomUUID();
  ctx.state.correlationId = id;          // available to all inner layers via ctx.state
  ctx.set('X-Correlation-ID', id);       // returned to client in response headers
  await correlationStore.run(id, next);  // AsyncLocalStorage propagation
};
```

Behaviour: reads `X-Correlation-ID` from the incoming request header (allowing callers to pass their own trace IDs from upstream services) and falls back to a freshly generated UUID if absent. The ID travels in three channels: `ctx.state.correlationId` (synchronous, within Koa context), `correlationStore` (async-local, accessible anywhere in the call chain without passing arguments), and the `X-Correlation-ID` response header.

#### Layer 2 — `errorHandler` (`src/core/middleware/errorHandler.ts`)

Position: second — immediately inside correlation ID. Reason: it must wrap all inner layers so it can catch any error thrown anywhere in the request lifecycle. If it were last, errors thrown by `rateLimiter` or `helmet` would be unhandled.

```typescript
export const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();  // runs ALL inner layers inside this try block
  } catch (err) {
    if (err instanceof AppError) {
      ctx.status = err.statusCode;
      ctx.body = {
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
          correlationId: ctx.state.correlationId,  // always present (layer 1 ran first)
        },
      };
      if (err.statusCode >= 500) {
        logger.error({ err, correlationId: ctx.state.correlationId }, 'Unhandled app error');
      }
    } else {
      ctx.status = 500;
      ctx.body = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', correlationId: ctx.state.correlationId } };
      logger.error({ err, correlationId: ctx.state.correlationId }, 'Unhandled error');
    }
  }
};
```

Two branches:
- **Known error** (`err instanceof AppError`): translate to the status code and structured body defined by the error class. For `statusCode >= 500`, also log the full error object (which includes the stack trace) to aid debugging.
- **Unknown error**: always map to 500. The message is deliberately vague — "An unexpected error occurred" — to avoid leaking internal details. The real error is logged server-side with the correlation ID so engineers can look it up.

Note that `4xx` errors (client mistakes) are not logged at `error` level. Only `5xx` errors indicate a server-side problem worth alerting on.

#### Layer 3 — `requestLogger` (`src/core/middleware/requestLogger.ts`)

Position: inside `errorHandler`. Reason: it must log the final status code, which is only known after all inner layers (including the error handler's `catch` block) have run.

```typescript
export const requestLogger: Middleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  logger.info({
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    durationMs: Date.now() - start,
    correlationId: ctx.state.correlationId,
  }, 'request');
};
```

The timer starts before `await next()` and the log line fires after it. This measures the complete processing time including all inner middleware. Because this is structured logging (JSON fields, not a concatenated string), dashboards can aggregate on `durationMs`, filter by `status`, and group by `path` without regex parsing.

#### Layer 4 — `metricsMiddleware` (`src/infrastructure/metrics/MetricsMiddleware.ts`)

Position: inside `requestLogger`. Records Prometheus counters and histograms after the route handler runs. Placed after `requestLogger` because metrics are less critical than logging — if metrics fail, requests should still proceed.

#### Layer 5 — `rateLimiter` (`src/core/middleware/rateLimiter.ts`)

Position: before security headers and body parsing. Reason: rejecting rate-limited requests before parsing the body saves CPU on large payloads from flood attacks.

This implements a **sliding-window rate limiter using a Redis Sorted Set**:

```typescript
const key = `rate_limit:${ip}`;
const now = Date.now();
const windowStart = now - WINDOW_SECONDS * 1000;  // 60 seconds ago

await redis.zremrangebyscore(key, '-inf', windowStart);  // remove expired entries
const count = await redis.zcard(key);                    // count entries in window

if (count >= MAX_REQUESTS) {
  ctx.status = 429;
  ctx.body = { error: 'Too many requests. Please try again later.' };
  ctx.set('Retry-After', String(WINDOW_SECONDS));
  return;  // short-circuits: does NOT call next()
}

await redis.zadd(key, now, `${now}-${Math.random()}`);   // record this request
await redis.expire(key, WINDOW_SECONDS);

ctx.set('X-RateLimit-Limit', String(MAX_REQUESTS));
ctx.set('X-RateLimit-Remaining', String(MAX_REQUESTS - count - 1));

await next();
```

Each request is stored as a sorted set member with `score = timestamp`. "Expired" members (score older than the window start) are pruned on every request. The cardinality of the surviving set is the request count for the current window. This gives accurate sliding-window semantics without a fixed-bucket approximation. The default limit is 100 requests per 60 seconds per client IP, configurable via `RATE_LIMIT_MAX`.

#### Layer 6 — `helmet`

Sets security HTTP response headers: `X-Frame-Options`, `X-XSS-Protection`, `Strict-Transport-Security`, and a `Content-Security-Policy`. The CSP is customised to allow Swagger UI scripts from cdnjs:

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
    },
  },
}));
```

#### Layer 7 — `cors`

Handles preflight `OPTIONS` requests and attaches `Access-Control-Allow-Origin` headers. `credentials: true` allows cookies and `Authorization` headers to be sent cross-origin, which is required for the JWT Bearer flow.

#### Layer 8 — `bodyParser`

Parses `application/json` bodies and populates `ctx.request.body`. The `jsonLimit: '5mb'` cap prevents memory exhaustion from oversized payloads. Placed after security middleware because body parsing is only needed by actual route handlers, not by the rate limiter or helmet.

#### Layer 9 — Swagger / Spec Handlers

Two paths are intercepted before the API router:

- `GET /spec.json` — returns the generated OpenAPI specification object
- `GET /` — returns the Swagger UI HTML page

These are inline anonymous middlewares that return early without calling `next()` when the path matches.

#### Layer 10 — `apiRouter` (Routes)

All business endpoints are registered under the `/api/v1` prefix via `@koa/router`. Each domain router is mounted using `apiRouter.use(domainRouter.routes())`. The `allowedMethods()` call adds automatic `405 Method Not Allowed` responses for routes that exist but don't support the requested HTTP method.

The `healthRouter` is mounted directly on the app (not under `/api/v1`) so that load balancers and orchestration platforms can reach `GET /health` without authentication.

---

### 2.3 Full Request Lifecycle — ASCII Diagram

```
CLIENT                         SERVER PROCESS
  │                                 │
  │── TCP SYN / TLS handshake ─────►│ Node.js http.Server (src/server.ts)
  │                                 │
  │── HTTP POST /api/v1/issues ────►│
  │   Headers:                      │
  │     Authorization: Bearer <jwt> │
  │     Content-Type: application/json
  │   Body: { title: "...", ... }   │
  │                                 │
  │                          correlationId.ts
  │                          ├── read X-Correlation-ID header (or generate UUID)
  │                          ├── ctx.state.correlationId = id
  │                          ├── set response header X-Correlation-ID
  │                          └── correlationStore.run(id, next) ──────────────────────┐
  │                                 │                                                  │ AsyncLocalStorage
  │                          errorHandler.ts (try block opens)                        │ context active
  │                                 │                                                  │
  │                          requestLogger.ts                                          │
  │                          └── start = Date.now()  ──────────────► await next()     │
  │                                 │                                                  │
  │                          metricsMiddleware.ts                                      │
  │                          └── record request start ──────────────► await next()    │
  │                                 │                                                  │
  │                          rateLimiter.ts                                            │
  │                          ├── redis.zremrangebyscore (prune old entries)            │
  │                          ├── redis.zcard (count requests in window)                │
  │                          ├── if count >= MAX → 429, return (no next())            │
  │                          ├── redis.zadd (record this request)                     │
  │                          └── set X-RateLimit-* headers ────────► await next()    │
  │                                 │                                                  │
  │                          helmet / cors / bodyParser                                │
  │                          └── set security headers, parse JSON body                │
  │                                 │                                                  │
  │                          issueRoutes.ts  (Koa Router match)                       │
  │                          └── authenticate middleware (auth.ts)                    │
  │                              ├── extract Bearer token                              │
  │                              ├── jwt.verify(token, JWT_SECRET)                   │
  │                              ├── redis.exists(jwtRevoked:<jti>)                  │
  │                              └── ctx.state.user = { id, email }                  │
  │                                 │                                                  │
  │                          requireProjectRole('MEMBER') (rbac.ts)                  │
  │                          ├── membershipCache.get(projectId, userId)               │
  │                          ├── on miss: DB query → ProjectMember entity             │
  │                          ├── cache result with 5-min TTL                          │
  │                          └── compare roleRank — throw ForbiddenError if low       │
  │                                 │                                                  │
  │                          IssueController.ts                                       │
  │                          └── validate body with Joi schema                        │
  │                                 │                                                  │
  │                          IssueManager.ts                                          │
  │                          └── coordinate IssueCommandService                       │
  │                                 │                                                  │
  │                          IssueCommandService.ts                                   │
  │                          ├── business rule checks (workflow state, sprint capacity)│
  │                          ├── IssueRepository.save(newIssue)                       │
  │                          └── eventBus.emit('issue.created', payload)             │
  │                                 │                                                  │
  │                          IssueRepository.ts  (TypeORM)                            │
  │                          └── INSERT INTO issues (...) VALUES (...)               │
  │                                 │                                                  │
  │                          ── unwinds back through layers ──────────────────────────┘
  │                                 │
  │                          IssueController returns ok(issue)  → ctx.body = { data: {...} }
  │                                 │
  │                          requireProjectRole resumes (no-op after next())
  │                          authenticate resumes (no-op after next())
  │                          rateLimiter resumes (no-op after next())
  │                          metricsMiddleware resumes → record duration, increment counter
  │                          requestLogger resumes → log { method, path, status, durationMs }
  │                          errorHandler resumes (no exception thrown — try block exits cleanly)
  │                          correlationId resumes (no-op after next())
  │                                 │
  │◄── HTTP 201 ────────────────────┤
  │    Headers:                     │
  │      X-Correlation-ID: <uuid>   │
  │      X-RateLimit-Limit: 100     │
  │      X-RateLimit-Remaining: 87  │
  │      Content-Type: application/json
  │    Body:                        │
  │      { "data": { "id": "...", "title": "...", ... } }
```

---

### 2.4 The AppError Hierarchy

The `AppError` base class (`src/core/errors/AppError.ts`) carries four pieces of information:

```typescript
export class AppError extends Error {
  constructor(
    public readonly code: string,       // machine-readable string, e.g. "NOT_FOUND"
    public readonly statusCode: number, // HTTP status code
    message: string,                    // human-readable description
    public readonly details?: unknown,  // optional structured context
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);  // clean stack — no AppError frames
  }
}
```

`Error.captureStackTrace(this, this.constructor)` removes the `AppError` constructor frame from the stack trace, so when you print the stack you see the business code that threw the error, not the error class internals.

The concrete subclasses in `src/core/errors/errors.ts`:

| Class | HTTP Status | Code | Typical Use |
|---|---|---|---|
| `NotFoundError` | 404 | `NOT_FOUND` | Entity lookup returned null |
| `ConflictError` | 409 | `CONFLICT` | Optimistic lock version mismatch |
| `ValidationError` | 400 | `VALIDATION_ERROR` | Joi schema validation failed |
| `ForbiddenError` | 403 | `FORBIDDEN` | User lacks required role |
| `UnprocessableError` | 422 | `UNPROCESSABLE` | State machine transition rejected |
| `UnauthorizedError` | 401 | `UNAUTHORIZED` | Missing or invalid JWT |

Usage example from inside a service:

```typescript
// Any service method — no HTTP knowledge required
const issue = await this.repo.findById(id);
if (!issue) throw new NotFoundError('Issue', id);
```

The service does not know or care about HTTP. It throws a typed domain exception. The `errorHandler` middleware intercepts it and translates it to `{ status: 404, body: { error: { code: "NOT_FOUND", message: "Issue '42' not found" } } }`.

---

### 2.5 The ApiResponse Envelope

Successful responses use `ok()` from `src/core/types/ApiResponse.ts`:

```typescript
export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export const ok = <T>(data: T, meta?: Record<string, unknown>): ApiResponse<T> => ({ data, meta });
```

A controller uses it like this:

```typescript
ctx.status = 201;
ctx.body = ok(createdIssue, { projectKey: 'PROJ' });
```

The response body becomes:

```json
{
  "data": {
    "id": "uuid-here",
    "title": "Implement login flow",
    "status": "TODO"
  },
  "meta": {
    "projectKey": "PROJ"
  }
}
```

Error responses (generated by `errorHandler`) have a parallel but distinct shape:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Issue '99' not found",
    "details": null,
    "correlationId": "b3a1f9e2-..."
  }
}
```

Why does the envelope matter? API clients (web frontend, mobile app, third-party integrations) can write a single interceptor:

```typescript
// Client-side — works for every endpoint
if ('error' in response) {
  showError(response.error.message);
  logToSentry({ correlationId: response.error.correlationId });
} else {
  renderData(response.data);
}
```

Without a consistent envelope, each endpoint would require bespoke parsing logic.

---

### 2.6 RBAC Middleware — `requireProjectRole`

`src/core/middleware/rbac.ts` is a **middleware factory**: it returns a Koa middleware function configured for a specific minimum role. Route definitions look like:

```typescript
// Somewhere in projectRoutes.ts
router.delete(
  '/:projectId',
  authenticate,
  requireProjectRole(ProjectRole.ADMIN),
  controller.deleteProject,
);
```

The role hierarchy is encoded in `roleRank`:

```typescript
const roleRank: Record<ProjectRole, number> = {
  [ProjectRole.ADMIN]: 4,
  [ProjectRole.PROJECT_LEAD]: 3,
  [ProjectRole.MEMBER]: 2,
  [ProjectRole.VIEWER]: 1,
};
```

A `PROJECT_LEAD` (rank 3) satisfies `requireProjectRole(ProjectRole.MEMBER)` (rank 2) because `3 >= 2`. The role is looked up from `MembershipCache` first (5-minute TTL Redis cache), falling back to a database query on cache miss. The cache is invalidated by `ProjectService` whenever membership changes, ensuring stale roles are never honored for more than 5 minutes.

---

### 2.7 Auth Middleware — JWT + Revocation Check

`src/core/middleware/auth.ts` performs three operations in sequence:

```typescript
// 1. Header presence
if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Bearer token');

// 2. Cryptographic verification
payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

// 3. Revocation check (active logout / key rotation)
const revoked = await redis.exists(CacheKeys.jwtRevoked(payload.jti));
if (revoked) throw new UnauthorizedError('Token has been revoked');

// 4. Attach user identity to request context
ctx.state.user = { id: payload.sub, email: payload.email };
```

`jti` is the JWT ID claim — a unique identifier per token. When a user logs out, the server stores `jwtRevoked:<jti>` in Redis with an expiry equal to the token's remaining lifetime. Any subsequent request with that token hits the Redis check and is rejected, even though the token is cryptographically valid. This is the standard pattern for implementing stateless JWT revocation.

---

## Key Takeaways

- Hexagonal architecture makes the business logic layer independent of infrastructure. Services depend on repository *interfaces* (ports), not TypeORM classes (adapters), so they can be unit-tested without a database.
- Koa's onion model gives every middleware a symmetric "before" and "after" phase around `await next()`. This is why `requestLogger` measures total duration and `errorHandler` catches errors from all inner layers — both are impossible in Express's linear pipeline without callbacks.
- `correlationId` must be the outermost middleware because every other layer — including the error handler — needs to embed the ID in logs and response bodies. `AsyncLocalStorage` propagates the ID through the entire async call chain without polluting function signatures.
- `errorHandler` must be the second middleware (immediately inside `correlationId`). Its `try/catch` wraps all inner layers. Placing it last would leave middleware such as `rateLimiter` and `helmet` unprotected.
- The `AppError` hierarchy separates the concern of "what went wrong" (domain code throws `NotFoundError`) from "how to respond" (HTTP adapter translates it to 404). Services never import `ctx`, `req`, or `res`.
- Rate limiting uses a Redis sliding-window sorted set rather than a fixed-bucket counter. Fixed buckets allow burst attacks at bucket boundaries (100 requests in the last millisecond of minute N, 100 more in the first millisecond of minute N+1). A sliding window has no such boundary.
- The `ApiResponse` envelope (`{ data }` for success, `{ error }` for failure) lets clients write a single response-handling interceptor instead of parsing each endpoint's bespoke format.
- `env.ts` fails at import time with a clear Joi error if any required environment variable is missing or invalid. This is "fail-fast" configuration: it is better to crash on startup with a readable message than to crash mid-request with a cryptic `undefined is not a string` error.

---

## Further Reading

- **"Hexagonal Architecture" (original article)** — Alistair Cockburn, 2005. The primary source. Available at `alistair.cockburn.us/hexagonal-architecture`.
- **"Growing Object-Oriented Software, Guided by Tests"** — Steve Freeman & Nat Pryce (Addison-Wesley, 2009). The canonical text on port-and-adapter design combined with test-driven development. Chapters 6 and 7 cover exactly how to design the seams that make mocking possible.
- **RFC 7230 — Hypertext Transfer Protocol (HTTP/1.1): Message Syntax and Routing**. Section 3 covers how headers and bodies are framed on the wire — the level at which `bodyParser` and `helmet` operate.
- **"Release It! Design and Deploy Production-Ready Software"** — Michael Nygard (Pragmatic Bookshelf, 2nd ed. 2018). Chapters on bulkheads, circuit breakers, and timeouts explain why rate limiting and graceful shutdown (both present in this codebase) are mandatory for production services.
- **Node.js `async_hooks` documentation** — `nodejs.org/api/async_hooks.html`. The official reference for `AsyncLocalStorage`, covering the propagation semantics relied upon by `correlationId.ts`.
