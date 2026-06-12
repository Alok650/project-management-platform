# Observability — Logging, Metrics & Tracing

## What You'll Learn

- The three pillars of observability and why each one is necessary
- What structured logging is and why JSON logs are superior to plain-text strings in production
- How a correlation ID propagates through a request and ties hundreds of log lines together into a single trace
- The Prometheus pull model and the four metric types: Counter, Gauge, Histogram, and Summary
- The difference between a liveness probe and a readiness probe, and why Kubernetes needs both
- How log levels work and how `LOG_LEVEL` is used to suppress noise in production without recompiling
- A line-by-line walkthrough of every observability file in this codebase

---

## Part 1 — Theory

### 1.1 The Three Pillars of Observability

Observability is the ability to understand the internal state of a running system purely from its external outputs. The term comes from control theory: a system is "observable" if you can determine its internal state by examining its outputs over time.

In practice, three categories of output give you that understanding:

| Pillar | Question it answers | Storage |
|--------|-------------------|---------|
| **Logs** | "What happened, in what order, with what data?" | Elasticsearch, Loki, CloudWatch Logs |
| **Metrics** | "How many? How fast? How long? Right now?" | Prometheus, InfluxDB, Datadog |
| **Traces** | "Which code path did this one request follow, across which services?" | Jaeger, Zipkin, AWS X-Ray |

Think of a car dashboard as an analogy:
- The **speedometer** (gauge) is a metric — it tells you the current value of a quantity.
- The **check-engine light** is a log event — something happened and it was recorded.
- The **GPS route replay** showing everywhere the car went is a trace — the full path of one journey through space.

You need all three. Metrics tell you that the p99 latency spiked at 14:23. Logs tell you which requests were slow and what SQL they ran. Traces tell you that the slowness came from service B calling service C, not from the database itself.

This codebase implements the first two pillars (logs and metrics) in depth. Distributed tracing (OpenTelemetry spans) is the natural next step but is not yet wired in.

---

### 1.2 Structured Logging

#### The Problem With Plain-Text Logs

Imagine you have 50 million log lines per day. A developer wants to find every request that took more than 500 ms and returned a 500 status. With plain-text logs, you write a fragile grep pattern:

```bash
# Brittle — breaks if the message format ever changes
grep "500" app.log | grep "duration.*[5-9][0-9][0-9]ms"
```

If someone adds a space, renames a field, or adds a prefix, the grep silently returns the wrong results.

#### Structured Logging With JSON

Structured logging means every log line is a machine-parseable record — usually JSON. Instead of:

```
[2026-06-12T09:15:32Z] INFO request POST /api/boards 201 243ms
```

You emit:

```json
{
  "level": "info",
  "time": "2026-06-12T09:15:32.441Z",
  "service": "pmp-api",
  "msg": "request",
  "method": "POST",
  "path": "/api/boards",
  "status": 201,
  "durationMs": 243,
  "correlationId": "c7e3f1a2-8b44-4d9c-a1e0-3f2d9b8c7a11"
}
```

Now a log aggregation tool (Elasticsearch, Grafana Loki, Datadog) can index `durationMs` as a number, `status` as an integer, and `correlationId` as a keyword. Your query becomes:

```
status:500 AND durationMs:>500
```

This is typed, indexed, and sub-second on hundreds of millions of records.

#### Why Pino Specifically?

`console.log` is synchronous and blocks the Node.js event loop for every log write. `pino` writes to stdout asynchronously using a worker thread, benchmarks show it is 5-8x faster than `winston` and 10x faster than `bunyan`. In a high-throughput API, that difference is measurable in p99 latency.

---

### 1.3 Correlation IDs

#### The Problem

A single HTTP request to `POST /api/boards` might:

1. Hit the Koa middleware stack
2. Call the use-case layer
3. Run three database queries
4. Publish a domain event to SQS
5. Log something in the cache layer

Each of those steps might emit its own log line. Without a shared identifier, you have hundreds of log lines per second with no way to group the five lines that belong to one request.

#### The Solution: Correlation IDs

A correlation ID (also called a request ID or trace ID) is a UUID generated at the edge of the system — the very first middleware. It is:

1. Attached to `ctx.state` so every piece of Koa middleware can read it
2. Set as the `X-Correlation-ID` response header so clients and API gateways can forward it
3. Bound to every log line via a child logger

Here is the concept in pseudocode before we look at the real implementation:

```typescript
// Pseudocode — the idea
async function handleRequest(req, res, next) {
  const id = req.headers['x-correlation-id'] ?? generateUUID();
  req.correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  await next(); // all downstream code can read req.correlationId
}
```

Now every log line from that request carries the same UUID. In Kibana or Grafana Loki you filter by `correlationId:"c7e3f1a2-..."` and see the complete story of that one request across every layer of the application.

#### AsyncLocalStorage

There is a subtlety in Node.js: async functions do not have a stack frame you can attach data to. If you set `req.correlationId` in middleware but then call a service function that has no reference to `req`, that function cannot read the ID.

`AsyncLocalStorage` (from Node's built-in `async_hooks` module) solves this. It is like a thread-local variable, but for async call chains. Any code that runs inside `correlationStore.run(id, callback)` can call `correlationStore.getStore()` to get the current ID — even if `req` was never passed to that code.

---

### 1.4 Prometheus and the Pull Model

#### What Is Prometheus?

Prometheus is an open-source monitoring system that stores time-series data. It uses a **pull model**: instead of your application pushing metrics to a server, Prometheus scrapes a `/metrics` HTTP endpoint on your application every 15 seconds (configurable). This has several advantages:

- **Simple**: your app just serves an HTTP endpoint.
- **Firewall-friendly**: Prometheus initiates the connection, not your app.
- **Health detection**: if the scrape fails, Prometheus knows your service is down.

#### The Text Exposition Format

When Prometheus scrapes `/metrics`, your app responds with a plain-text body like this:

```
# HELP http_request_duration_seconds HTTP request duration in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="0.005"} 12
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="0.01"} 47
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="0.025"} 201
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="0.05"} 438
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="0.1"} 601
http_request_duration_seconds_bucket{method="GET",route="/api/boards",status="200",le="+Inf"} 601
http_request_duration_seconds_sum{method="GET",route="/api/boards",status="200"} 22.91
http_request_duration_seconds_count{method="GET",route="/api/boards",status="200"} 601

# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/boards",status="200"} 601
http_requests_total{method="POST",route="/api/boards",status="201"} 34

# HELP active_connections Number of active HTTP connections
# TYPE active_connections gauge
active_connections 7

# HELP domain_events_total Total number of domain events published
# TYPE domain_events_total counter
domain_events_total{type="BoardCreated"} 34
domain_events_total{type="IssueAssigned"} 118
```

#### The Four Metric Types

**Counter** — a monotonically increasing integer. It only goes up (or resets to zero on process restart). Use it for things you count: requests served, errors thrown, events published. You can compute the rate of increase with PromQL's `rate()` function.

```
rate(http_requests_total[5m])  -- requests per second over a 5-minute window
```

**Gauge** — an arbitrary number that can go up or down. Use it for things you measure right now: active connections, queue depth, memory usage, number of logged-in users.

**Histogram** — records the distribution of a value by bucketing observations. Each bucket counts how many observations fell below a threshold. From the buckets Prometheus can compute percentiles: p50, p95, p99. Use it for latencies and payload sizes where the distribution shape matters, not just the average.

**Summary** — similar to a histogram but calculates quantiles client-side. Summaries cannot be aggregated across instances (you cannot add quantiles), so histograms are almost always preferred in distributed systems.

---

### 1.5 Health Checks: Liveness vs. Readiness

#### Why Health Endpoints Exist

Kubernetes runs your container and periodically probes it to decide:

- **Should I restart this container?** (liveness)
- **Should I send it traffic?** (readiness)

These are different questions with different answers.

#### Liveness: "Is the process alive?"

A liveness probe asks a minimal question: is the Node.js process running and able to respond to HTTP? If it returns any 2xx, the container stays alive. If it fails repeatedly (timeouts or 5xx), Kubernetes kills and restarts the pod.

The probe should be cheap and never fail unless the process is genuinely broken. It should **not** check the database — a database being down is not a reason to kill and restart the Node.js process.

```
GET /api/health/live
→ 200 { "status": "ok" }
```

#### Readiness: "Should I route traffic here?"

A readiness probe asks: is this instance ready to serve user traffic? If a pod is starting up and the database connection pool is not yet established, it should return 503. Kubernetes will remove it from the load balancer rotation until it becomes ready.

```
GET /api/health/ready
→ 200 { "status": "ok",      "checks": { "database": "ok", "redis": "ok" } }
→ 503 { "status": "degraded", "checks": { "database": "error", "redis": "ok" } }
```

The 503 response body tells the on-call engineer exactly which dependency is failing without needing to ssh into anything.

Load balancers (AWS ALB, NGINX, HAProxy) use the readiness endpoint in the same way: if a target returns 503 on the health path, it is taken out of rotation.

---

### 1.6 Log Levels

Every structured logger supports multiple severity levels. The convention from lowest to highest is:

| Level | Meaning | Use in this codebase |
|-------|---------|---------------------|
| `trace` | Extremely verbose internal state | Not emitted by default |
| `debug` | Development-time diagnostics | Disabled in production |
| `info` | Normal operational events (request completed, event published) | Default level |
| `warn` | Something unusual happened but the system recovered | Validation failures, retries |
| `error` | An operation failed; human attention may be needed | Unhandled exceptions |
| `fatal` | The process cannot continue | Config validation failure at startup |

Setting `LOG_LEVEL=info` tells pino to suppress `debug` and `trace` messages. This is critical in production because debug logs can easily represent 90% of log volume and cost significant money in a cloud log aggregation service.

The `env.ts` schema defines the valid levels:

```typescript
// src/config/env.ts — line 21
readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
```

And the Joi validation ensures the value is one of those six strings with `info` as the default:

```typescript
// src/config/env.ts — lines 43-45
LOG_LEVEL: Joi.string()
  .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
  .default('info'),
```

---

## Part 2 — Implementation Walkthrough

### 2.1 Logger.ts — Pino Configuration

**File:** `src/infrastructure/logger/Logger.ts`

```typescript
import pino from 'pino';
import { env } from '../../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  base: { service: 'pmp-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/** Returns a child logger with correlationId bound to every log line */
export const childLogger = (correlationId: string) =>
  logger.child({ correlationId });
```

Walking through each option:

**`level: env.LOG_LEVEL`** — pino discards any log call whose level is lower than this threshold before any serialization happens. This means a `logger.debug(...)` call at `LOG_LEVEL=info` costs almost no CPU — no object serialization, no I/O.

**`transport: { target: 'pino-pretty' }` (development only)** — In development, `pino-pretty` reformats the JSON output into colorized, human-readable lines. In production (`NODE_ENV !== 'development'`), transport is `undefined` and pino writes raw newline-delimited JSON to stdout. The container log collector (Fluentd, Filebeat, the Docker logging driver) picks up stdout and ships it to your log aggregation backend. Never use `pino-pretty` in production — it is 3x slower.

**`base: { service: 'pmp-api' }`** — Every log line will contain `"service": "pmp-api"`. When you have multiple services (API, worker, migration runner) sending logs to the same aggregation backend, this field lets you filter to just the API logs.

**`timestamp: pino.stdTimeFunctions.isoTime`** — emits timestamps as ISO 8601 strings (`"2026-06-12T09:15:32.441Z"`) rather than epoch milliseconds. ISO strings are human-readable without a calculator.

**`formatters.level: (label) => ({ level: label })`** — By default pino emits `"level": 30` (a numeric code). This formatter replaces the number with the string `"info"`. Humans and most log query UIs prefer the string form.

**`childLogger`** — pino's `child()` method creates a new logger instance with additional fields merged into every log line. Calling `childLogger('some-uuid')` returns a logger where every call — `info`, `warn`, `error` — automatically includes `"correlationId": "some-uuid"`. You never have to remember to pass the ID to each individual log call.

#### What the Output Looks Like

In production (`NODE_ENV=production`, `LOG_LEVEL=info`):

```json
{"level":"info","time":"2026-06-12T09:15:32.441Z","service":"pmp-api","method":"POST","path":"/api/boards","status":201,"durationMs":243,"correlationId":"c7e3f1a2-8b44-4d9c-a1e0-3f2d9b8c7a11","msg":"request"}
```

In development (`NODE_ENV=development`), pino-pretty renders it as:

```
[09:15:32.441] INFO (pmp-api): request
    method: "POST"
    path: "/api/boards"
    status: 201
    durationMs: 243
    correlationId: "c7e3f1a2-8b44-4d9c-a1e0-3f2d9b8c7a11"
```

---

### 2.2 correlationId.ts — Correlation ID Middleware

**File:** `src/core/middleware/correlationId.ts`

```typescript
import { Middleware } from 'koa';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export const correlationStore = new AsyncLocalStorage<string>();

/** Injects X-Correlation-ID into ctx.state and response headers; creates one if absent */
export const correlationId: Middleware = async (ctx, next) => {
  const id = (ctx.headers['x-correlation-id'] as string) ?? randomUUID();
  ctx.state.correlationId = id;
  ctx.set('X-Correlation-ID', id);
  await correlationStore.run(id, next);
};
```

**Data flow through this middleware:**

```
Incoming request
       |
       v
  Check ctx.headers['x-correlation-id']
       |
  +----|-----------------------------+
  |    | exists?                     |
  |    v                             |
  |  Use the caller's ID             |
  |  (forward from upstream service) |
  +----------------------------------+
       |
  No header? Generate randomUUID()
       |
       v
  ctx.state.correlationId = id   <-- Koa middleware chain can read this
  ctx.set('X-Correlation-ID', id) <-- goes back to the caller in response headers
       |
       v
  correlationStore.run(id, next)
       |
       v
  All downstream async code runs inside this AsyncLocalStorage context.
  Any code that calls correlationStore.getStore() gets the current ID,
  even if it has no reference to ctx.
```

**Why forward the incoming header?** In a microservices architecture, Service A calls Service B which calls Service C. If Service A set the correlation ID at the edge and passes it as `X-Correlation-ID`, every downstream service should reuse that ID so all logs across all services share the same identifier. This is the foundation of distributed tracing without a full OpenTelemetry setup.

**Why `AsyncLocalStorage`?** Consider this call chain:

```typescript
// boardService.ts has no reference to ctx
class BoardService {
  async create(dto: CreateBoardDto): Promise<Board> {
    // How do we log with the correct correlationId here?
    const id = correlationStore.getStore(); // works! AsyncLocalStorage delivers it
    childLogger(id).info({ boardName: dto.name }, 'creating board');
    // ...
  }
}
```

Without `AsyncLocalStorage`, you would need to thread `correlationId` through every function signature in the application. With it, the ID is available anywhere in the call chain automatically.

---

### 2.3 requestLogger.ts — Request Logging Middleware

**File:** `src/core/middleware/requestLogger.ts`

```typescript
import { Middleware } from 'koa';
import { logger } from '../../infrastructure/logger/Logger';

/** Logs method, path, status, and duration for every request */
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

The key design choice here is **when** the log is emitted. The `start` timestamp is captured before `await next()`, but the log call happens **after** `next()` returns. This means:

- `ctx.status` is the actual response status (set by route handlers below in the stack)
- `durationMs` is the total time from when the request entered this middleware to when the response was fully generated — the true end-to-end server-side latency

If the log were emitted before `next()`, `ctx.status` would still be the default `404` (Koa's default before a handler sets it) and `durationMs` would be 0.

**Fields logged for every request:**

| Field | Type | Example | Meaning |
|-------|------|---------|---------|
| `method` | string | `"POST"` | HTTP verb |
| `path` | string | `"/api/boards"` | URL path (no query string) |
| `status` | number | `201` | HTTP response status code |
| `durationMs` | number | `243` | Server-side wall-clock time in milliseconds |
| `correlationId` | string | `"c7e3f1a2-..."` | Correlation ID injected by the `correlationId` middleware |
| `msg` | string | `"request"` | Fixed string — makes it easy to filter just request-log lines |
| `service` | string | `"pmp-api"` | From `base` in Logger.ts — on every line |
| `level` | string | `"info"` | Log level |
| `time` | string | `"2026-06-12T09:15:32.441Z"` | ISO timestamp from pino |

The `correlationId` middleware must be registered **before** `requestLogger` in the Koa middleware stack so that `ctx.state.correlationId` is populated when `requestLogger` runs.

---

### 2.4 MetricsRegistry.ts — Prometheus Metrics Definitions

**File:** `src/infrastructure/metrics/MetricsRegistry.ts`

```typescript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export class MetricsRegistry {
  private static instance: MetricsRegistry;

  readonly registry:            Registry;
  readonly httpRequestDuration: Histogram<string>;
  readonly httpRequestTotal:    Counter<string>;
  readonly activeConnections:   Gauge<string>;
  readonly domainEventsTotal:   Counter<string>;

  private constructor() {
    this.registry = new Registry();

    this.httpRequestDuration = new Histogram({
      name:       'http_request_duration_seconds',
      help:       'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers:  [this.registry],
    });

    this.httpRequestTotal = new Counter({
      name:       'http_requests_total',
      help:       'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers:  [this.registry],
    });

    this.activeConnections = new Gauge({
      name:      'active_connections',
      help:      'Number of active HTTP connections',
      registers: [this.registry],
    });

    this.domainEventsTotal = new Counter({
      name:       'domain_events_total',
      help:       'Total number of domain events published',
      labelNames: ['type'],
      registers:  [this.registry],
    });
  }

  static getInstance(): MetricsRegistry {
    if (!MetricsRegistry.instance) MetricsRegistry.instance = new MetricsRegistry();
    return MetricsRegistry.instance;
  }
}

export const metricsRegistry = MetricsRegistry.getInstance();
```

The class uses the **Singleton pattern** (private constructor, static `getInstance()`). This ensures all four metrics are registered exactly once, even if multiple modules import `metricsRegistry`. Registering the same metric name twice to the same `Registry` would throw an error.

**`httpRequestDuration` (Histogram)**

This is the most important HTTP metric. The `buckets` array defines the upper boundaries for each bucket:

```
[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
  5ms   10ms  25ms   50ms  100ms 250ms 500ms 1s  2.5s  5s
```

Prometheus stores cumulative counts: `le="0.1"` means "how many requests completed in 100ms or less." From these buckets, Grafana can plot p50 (median), p95, and p99 latency lines — the most useful latency signals for an SLO dashboard.

Labels `method`, `route`, `status` let you slice the histogram:
- `method="GET", route="/api/boards"` — read latency for the boards list endpoint
- `status="500"` — latency of only the failing requests

**`httpRequestTotal` (Counter)**

Counts every completed request. Useful for:
- Traffic volume: `rate(http_requests_total[5m])` — requests per second
- Error rate: `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])` — fraction of requests that are 5xx errors

**`activeConnections` (Gauge)**

Tracks how many requests are currently in-flight. It goes up when a request enters `metricsMiddleware` and down when it exits. A gauge that stays permanently high indicates a goroutine/async leak or that your handlers are hanging.

**`domainEventsTotal` (Counter)**

A business metric, not an infrastructure metric. It counts domain events published (e.g., `BoardCreated`, `IssueAssigned`) broken down by `type`. This lets you plot business activity rates in Grafana alongside infrastructure metrics — a spike in `IssueAssigned` events at 14:30 right before a latency spike tells a story.

---

### 2.5 MetricsMiddleware.ts — Instrumentation Middleware

**File:** `src/infrastructure/metrics/MetricsMiddleware.ts`

```typescript
import { Context, Next } from 'koa';
import { metricsRegistry } from './MetricsRegistry';

export const metricsMiddleware = async (ctx: Context, next: Next): Promise<void> => {
  const end = metricsRegistry.httpRequestDuration.startTimer();
  metricsRegistry.activeConnections.inc();

  try {
    await next();
  } finally {
    const labels = {
      method: ctx.method,
      route:  ctx.routerPath ?? ctx.path,
      status: String(ctx.status),
    };
    end(labels);
    metricsRegistry.httpRequestTotal.inc(labels);
    metricsRegistry.activeConnections.dec();
  }
};
```

**How `startTimer()` works:**

`prom-client`'s `Histogram.startTimer()` captures `process.hrtime()` (nanosecond-precision wall clock) at call time and returns a function. When you call that returned function with labels, it computes the elapsed time and records the observation. This is more precise than `Date.now()` (millisecond resolution) and is the idiomatic prom-client pattern.

**Why `finally`:**

Koa's error handling can cause `next()` to throw. If the `finally` block were an `if/else`, metrics would not be recorded for failed requests, distorting your error rate calculations. The `finally` block guarantees metrics are always recorded regardless of whether the route handler threw.

**`ctx.routerPath ?? ctx.path`:**

`ctx.routerPath` is set by `@koa/router` and contains the route pattern, e.g., `/api/boards/:id`. `ctx.path` contains the resolved URL, e.g., `/api/boards/abc123`. Using `routerPath` is critical: if you use `ctx.path` as a label, each unique board ID creates a new label value (`route="/api/boards/abc123"`, `route="/api/boards/def456"`, ...). This is a **high-cardinality label explosion** — Prometheus memory usage grows proportionally to the number of unique label combinations and the metric becomes useless. With `routerPath`, every board lookup maps to the same label value `/api/boards/:id`.

**Data flow:**

```
Request arrives
      |
      v
metricsMiddleware enters
  activeConnections.inc()   <-- gauge: +1
  end = startTimer()        <-- captures hrtime
      |
      v
  await next()              <-- route handlers run
      |
      v (try/finally — always executes)
  end({ method, route, status })  <-- histogram: observe elapsed seconds
  httpRequestTotal.inc(...)       <-- counter: +1
  activeConnections.dec()         <-- gauge: -1
      |
      v
Response sent
```

---

### 2.6 HealthController.ts — Liveness, Readiness, and Metrics Endpoints

**File:** `src/modules/health/HealthController.ts`

```typescript
import { Context } from 'koa';
import { AppDataSource } from '../../config/database';
import { redis } from '../../config/redis';
import { metricsRegistry } from '../../infrastructure/metrics/MetricsRegistry';

export class HealthController {
  /** GET /api/health/live — always 200 if process is alive */
  static live(ctx: Context): void {
    ctx.body = { status: 'ok' };
  }

  static async ready(ctx: Context): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {};
    let healthy = true;

    try {
      await AppDataSource.query('SELECT 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'error';
      healthy = false;
    }

    try {
      await redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'error';
      healthy = false;
    }

    ctx.status = healthy ? 200 : 503;
    ctx.body   = { status: healthy ? 'ok' : 'degraded', checks };
  }

  static async metrics(ctx: Context): Promise<void> {
    ctx.set('Content-Type', metricsRegistry.registry.contentType);
    ctx.body = await metricsRegistry.registry.metrics();
  }
}
```

**`live` — liveness probe (line 9)**

This is as simple as it gets. If the Node.js process can execute code and respond to HTTP, this returns 200. It will never return 503 — if the process cannot respond, Kubernetes detects a timeout, which also triggers a restart.

**`ready` — readiness probe (lines 17-38)**

The method wraps each dependency check in its own `try/catch`. This is deliberate: if the database check throws, execution continues to the Redis check. The final status is the logical AND of all checks.

The `SELECT 1` query is the canonical "is the database connection alive?" check. It executes in under 1ms and exercises the connection pool. If TypeORM's connection pool is broken or the database is unreachable, this throws.

`redis.ping()` sends the Redis PING command and expects PONG back. If Redis is down or the TCP connection is broken, this throws.

The response body from a partially degraded system:

```json
{
  "status": "degraded",
  "checks": {
    "database": "ok",
    "redis": "error"
  }
}
```

An SRE on call can see immediately that Redis is the problem — no need to check logs first.

**`metrics` — Prometheus scrape target (lines 42-45)**

`metricsRegistry.registry.contentType` is `"text/plain; version=0.0.4; charset=utf-8"` — the MIME type Prometheus expects. `registry.metrics()` serializes all registered metrics into the text exposition format shown in section 1.4.

**Routes registered in `healthRoutes.ts`:**

```typescript
healthRouter.get('/api/health/live',  HealthController.live);
healthRouter.get('/api/health/ready', HealthController.ready);
healthRouter.get('/metrics',          HealthController.metrics);
```

Note that `/metrics` is at the root path, not under `/api`. This is conventional: Prometheus configuration typically scrapes `http://host:3000/metrics`. Putting it under `/api` would require non-standard Prometheus configuration.

---

### 2.7 End-to-End Request Flow

Here is the complete observability data flow for a single request:

```
Client: POST /api/boards
           |
           v
  [Koa Middleware Stack — in registration order]
           |
           v
  correlationId middleware
    - reads X-Correlation-ID header (or generates UUID)
    - sets ctx.state.correlationId
    - sets X-Correlation-ID response header
    - wraps rest of call chain in AsyncLocalStorage context
           |
           v
  requestLogger middleware
    - records start = Date.now()
    - awaits next() ...
           |
           v
  metricsMiddleware
    - calls httpRequestDuration.startTimer()
    - increments activeConnections gauge
    - awaits next() ...
           |
           v
  Route handler: BoardController.create()
    - validates DTO
    - calls BoardService.create()
    - sets ctx.status = 201, ctx.body = { ... }
           |
    returns to metricsMiddleware finally block
           |
           v
  metricsMiddleware (finally)
    - records httpRequestDuration observation
    - increments httpRequestTotal counter
    - decrements activeConnections gauge
           |
    returns to requestLogger (after next())
           |
           v
  requestLogger (after await next())
    - logs: { method, path, status, durationMs, correlationId }
           |
           v
  Response sent to client with X-Correlation-ID header
```

The same request produces:

1. **One log line** in stdout:
   ```json
   {"level":"info","time":"2026-06-12T09:15:32.441Z","service":"pmp-api","method":"POST","path":"/api/boards","status":201,"durationMs":243,"correlationId":"c7e3f1a2-8b44-4d9c-a1e0-3f2d9b8c7a11","msg":"request"}
   ```

2. **Three metric increments** visible on the next Prometheus scrape:
   - `http_request_duration_seconds` histogram observation of 0.243 seconds
   - `http_requests_total{method="POST",route="/api/boards",status="201"}` +1
   - `active_connections` momentarily +1 then -1

---

## Key Takeaways

- **Observability has three pillars** — logs answer "what happened," metrics answer "how many/how fast," and traces answer "which path did this request take." This codebase fully implements logs and metrics; distributed tracing with OpenTelemetry is the natural next step.

- **Structured JSON logs** make it possible to query, filter, and aggregate log data with typed predicates in log aggregation tools. Never use `console.log` in a production service — it is synchronous, unstructured, and slow.

- **pino over winston or bunyan** — pino's asynchronous worker-thread architecture makes it 5-10x faster in throughput benchmarks, which matters when log volume is high and the event loop cannot afford to block.

- **Correlation IDs are the poor-man's distributed trace** — by generating a UUID at the edge, attaching it to every log line via a child logger, and forwarding it in the `X-Correlation-ID` header to downstream services, you can reconstruct the complete story of a request from logs alone without a full tracing backend.

- **`AsyncLocalStorage` threads context through async call chains** without polluting every function signature with an extra parameter. Any code that runs inside `correlationStore.run()` can call `correlationStore.getStore()` to retrieve the current correlation ID.

- **Prometheus histograms with route-pattern labels** (not resolved URLs) give you p50/p95/p99 latency per endpoint. Using resolved URLs as labels creates high-cardinality label explosion that consumes unbounded Prometheus memory and makes the metric unusable.

- **Liveness and readiness probes answer different questions** — liveness asks "is the process alive?" (should Kubernetes restart it?) and readiness asks "is it ready to serve traffic?" (should the load balancer route to it?). A database being unavailable should make a pod not-ready but should never trigger a restart.

- **`LOG_LEVEL` is the most impactful performance tuning knob** for logging — setting it to `info` in production eliminates debug and trace calls before any serialization or I/O happens, reducing log volume and CPU overhead by an order of magnitude compared to running at `debug`.

---

## Further Reading

- **"Distributed Systems Observability"** by Cindy Sridharan (O'Reilly, 2018) — the canonical short book on the three pillars; explains when each pillar is needed and how they complement each other.

- **Prometheus documentation — Data Model and Metric Types** — https://prometheus.io/docs/concepts/data_model/ — the authoritative reference on counters, gauges, histograms, and summaries with guidance on when to use each.

- **Google SRE Book, Chapter 6 — Monitoring Distributed Systems** — https://sre.google/sre-book/monitoring-distributed-systems/ — explains the four golden signals (latency, traffic, errors, saturation), which map directly to the metrics implemented in this codebase.

- **pino documentation** — https://getpino.io/#/ — covers child loggers, transports, redaction (for masking PII like passwords and tokens in log output), and asynchronous logging configuration.

- **OpenTelemetry specification** — https://opentelemetry.io/docs/concepts/signals/ — the vendor-neutral standard for distributed tracing, metrics, and logs. When this codebase is ready to add the third pillar (traces), OpenTelemetry with the `@opentelemetry/sdk-node` package is the correct implementation path.
