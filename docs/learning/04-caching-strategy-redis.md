# Caching Strategy with Redis

## What You'll Learn

- What a cache is, why it exists, and how to measure its effectiveness (hit ratio)
- The Cache-Aside (Lazy Loading) pattern — the most common caching strategy in production systems
- How TTLs work, how to reason about their values, and the staleness trade-off
- Why cache invalidation is one of the hardest problems in computer science
- What a read model / projection is and how it differs from the write model
- What Redis is, how it differs from a relational database, and when to reach for it
- The main Redis data structures and when each one is the right tool
- What a cache stampede is and how to prevent it
- How this codebase implements three distinct Redis caches: `MembershipCache`, `IssueEntityCache`, and `IssueIndexCache`
- The complete read and write/invalidation data flows, traced through real code

---

## Part 1: Theory

### 1.1 What Is a Cache?

A cache is a fast, ephemeral storage layer placed in front of a slower, authoritative data source. The fundamental bet is: reading the same data from a fast store many times is cheaper than reading it from a slow store many times.

Imagine a librarian who is asked for the same book 500 times a day. Rather than walking to the shelves each time, they keep the five most-requested books on their desk. The desk is the cache. The shelves are the database.

**Cache hit**: the requested data exists in the cache. The fast path is taken; the slow store is not consulted.

**Cache miss**: the requested data is absent (never stored, or expired, or evicted). The slow store is queried, and the result is usually written into the cache so future requests become hits.

**Cache hit ratio** (also called hit rate) is the fraction of total requests that were served from cache:

```
hit ratio = cache hits / (cache hits + cache misses)
```

A ratio of 0.95 means 95 of every 100 requests never touched the database. This is the single most important metric for a cache. If your hit ratio is below ~0.70 you are probably caching the wrong data, using too short a TTL, or your access pattern is not repetitive enough to benefit from caching.

### 1.2 The Cache-Aside (Lazy Loading) Pattern

Cache-Aside is the most widely-deployed caching strategy. The application code — not a middleware or the database — is responsible for reading from the cache and writing to it. The cache exists "beside" the data store, not in line with it.

#### Read path

```
function getUser(userId):
    value = cache.get("user:" + userId)
    if value is not null:
        return value          // cache HIT — done

    // cache MISS — go to the authoritative source
    value = database.query("SELECT * FROM users WHERE id = ?", userId)
    cache.set("user:" + userId, value, ttl=300)
    return value
```

#### Write path

```
function updateUser(userId, newName):
    database.update("UPDATE users SET name = ? WHERE id = ?", newName, userId)
    cache.del("user:" + userId)   // invalidate — next read will repopulate
```

Notice the write path deletes the cache entry rather than updating it. Deleting is simpler and avoids a whole class of race conditions (see section 1.4). The next read will experience a miss and repopulate the cache with fresh data.

**Why "lazy"?** The cache is only populated when data is first requested. There is no background process that pre-loads the cache. This keeps the implementation simple: you only cache what is actually accessed, not what might be accessed.

**Trade-off**: The very first request after a miss (or a restart) goes to the database. This is usually fine. The exception is a cache stampede (section 1.7).

### 1.3 Time To Live (TTL)

A TTL is the maximum age of a cached value. After the TTL elapses, Redis automatically deletes the key. This provides a safety net: even if you forget to invalidate a key after a write, the stale data will eventually disappear.

```bash
# Store a value that expires after 300 seconds
SETEX board:proj_123:sprint:sprint_456  300  '{"columns": [...]}'

# Check how many seconds remain
TTL board:proj_123:sprint:sprint_456
# => 247
```

#### How to choose a TTL

There is no universal answer. You reason about two opposing forces:

| Shorter TTL | Longer TTL |
|---|---|
| More cache misses | Fewer cache misses |
| Lower staleness risk | Higher staleness risk |
| More DB load | Less DB load |
| Simpler invalidation story | Requires careful invalidation |

Ask yourself:
1. **How often does this data change?** Membership roles change rarely; individual issue fields change constantly during active sprints.
2. **How bad is stale data?** Stale RBAC data could allow unauthorized access (bad). Stale issue titles for 60 seconds are harmless.
3. **How many requests per second is this data serving?** If a board view serves 200 RPS and rebuilding it takes 50 ms of DB query time, a 300-second TTL means the DB is hit at most once every 300 seconds instead of 200 times per second.

The TTL is a **safety net**, not a replacement for explicit invalidation. A good system does both: explicit invalidation on writes (correctness) plus a TTL (protection against missed invalidations).

### 1.4 Cache Invalidation

Phil Karlton famously said: "There are only two hard things in Computer Science: cache invalidation and naming things."

**Why is it hard?** Because a cache is a denormalization: you have the same logical data stored in two places (the database and the cache). Any time the authoritative source changes, you must also update or remove the copy. Keeping two representations of the same data in sync — across network partitions, concurrent writers, and application restarts — is the core difficulty.

The failure modes are:

**Stale read**: A client reads old data from the cache because a write invalidated the DB copy but the cache copy was not yet deleted. The client makes a decision based on false information.

**Phantom invalidation**: A cache key is deleted that does not exist (harmless but wasteful).

**Race between write and invalidation**: Two servers execute the following sequence simultaneously:

```
Server A:                          Server B:
  read DB -> got v1
                                     write DB -> v2
                                     cache.del(key)
  cache.set(key, v1)   <-- stale v1 just replaced v2 in cache!
```

This is exactly why Cache-Aside writes **delete** the key rather than setting it: a delete cannot restore stale data, but a set can. After the delete, the next read will go to the DB and get v2.

**Scoped vs. broadcast invalidation**: If your cache key is `board:proj_123:sprint:sprint_456`, a write in sprint_789 should not invalidate sprint_456's cache. This requires your cache keys to encode exactly the scope of the data they hold. If the key were just `board:proj_123`, any write in any sprint would evict the entire project's board cache.

### 1.5 Read Models and Projections

In a CQRS (Command Query Responsibility Segregation) architecture, the write model and read model are deliberately separate.

**Write model**: the normalized, relational representation of your domain. In a relational database, this means tables with foreign keys, constraints, and indices tuned for transactional writes. An issue row in the `issues` table contains a `statusId` foreign key, not the full status name.

**Read model (projection)**: a denormalized, query-optimized shape of data built for a specific use-case. It may join multiple tables, flatten nested structures, and include computed fields. It is not stored in the primary DB; it lives in Redis, Elasticsearch, a materialized view, or a separate read replica.

Analogy: the write model is your filing cabinet (organized for correctness and completeness). The read model is the summary report your manager asks for every morning (organized for fast comprehension, not for filing).

In this codebase, `BoardView` is the read model. It is never written to MySQL. It is assembled from the write model and cached in Redis:

```typescript
// src/read-models/BoardView.ts
export interface BoardIssue {
  readonly id:          string;
  readonly issueKey:    string;
  readonly type:        string;
  readonly title:       string;
  readonly priority:    string;
  readonly storyPoints: number | null;
  readonly assignee:    { readonly id: string; readonly displayName: string } | null;
  readonly parentId:    string | null;
  readonly labels:      string[];
  readonly version:     number;
}

export interface BoardColumn {
  readonly statusId:   string;
  readonly statusName: string;
  readonly category:   string;
  readonly position:   number;
  readonly wipLimit:   number | null;
  readonly issues:     BoardIssue[];
}

export interface BoardView {
  readonly projectId: string;
  readonly sprintId:  string | null;
  readonly columns:   BoardColumn[];
  readonly cachedAt:  string;
}
```

Notice what is absent: there are no join table IDs, no `createdAt`/`updatedAt` audit timestamps on individual issues, no reporter fields. The shape contains exactly what the board UI needs to render columns and cards — nothing more. This is why it is a projection: it "projects" the full domain model onto a specific view-shaped shadow.

### 1.6 What Is Redis?

Redis (Remote Dictionary Server) is an in-memory data structure store. It holds all its data in RAM, which makes reads and writes orders of magnitude faster than a disk-backed relational database.

| Dimension | MySQL (relational DB) | Redis |
|---|---|---|
| Storage | Disk (with buffer pool in RAM) | RAM |
| Typical latency | 1–20 ms | 0.1–1 ms |
| Data model | Tables, rows, columns, JOIN | Named keys holding typed values |
| Durability | Full ACID, persistent | Optional (AOF/RDB), not ACID |
| Query language | SQL (arbitrary expressions) | Command per data structure |
| Ideal for | Authoritative, relational data | Ephemeral, high-read auxiliary data |

**When to use Redis instead of MySQL:**
- You need sub-millisecond reads (caching, rate limiting, session storage)
- The data is derivable from the authoritative source (so losing it on a restart is acceptable with a rebuild)
- You need atomic counters, sorted sets, or pub/sub that SQL does not offer naturally

**When to keep data in MySQL:**
- The data is the source of truth (you cannot rebuild it if it is lost)
- You need ACID transactions, foreign key constraints, or complex multi-table JOINs on write
- The data needs to outlive any cache TTL or eviction

### 1.7 Redis Data Structures

Redis is not a single data type. You choose the right structure for each access pattern.

#### Strings

The most general type. Holds any byte sequence — commonly used for JSON blobs, counters, and simple flags.

```bash
SET   user:42:profile  '{"name":"Alice","role":"admin"}'  EX 300
GET   user:42:profile
INCR  page:views:home     # atomic counter
```

Use strings when: you store an opaque blob (JSON, serialized object) or a single scalar value.

#### Hashes

A key pointing to a flat map of field–value pairs. More memory-efficient than storing many small strings when the hash has few fields.

```bash
HSET  presence:proj_123  user_42 "2026-06-12T10:00:00Z"
HSET  presence:proj_123  user_99 "2026-06-12T10:01:00Z"
HGET  presence:proj_123  user_42
HGETALL presence:proj_123
```

Use hashes when: the data is a collection of fields for one entity (user profile fields, presence timestamps per user).

#### Sorted Sets

A set of unique members, each with a floating-point score. The set is always sorted by score. This enables range queries by score and rank queries by position.

```bash
ZADD  idx:sprint:proj_123:sprint_456  1734000000000  "issue_789"
ZADD  idx:sprint:proj_123:sprint_456  1734000001000  "issue_790"
ZREVRANGE   idx:sprint:proj_123:sprint_456  0  -1          # all IDs, newest first
ZREVRANGEBYSCORE  idx:sprint:proj_123:sprint_456  (1734000001000  -inf  LIMIT 0 20
```

Use sorted sets when: you need an ordered index (pagination, leaderboards, time-ordered event logs, sliding-window rate limiting).

#### Sets

An unordered collection of unique strings. Supports O(1) membership tests and set operations (union, intersection, difference).

```bash
SADD   online:proj_123  user_42  user_99
SISMEMBER online:proj_123  user_42   # => 1
SINTERSTORE dest:both  set:a  set:b  # members in both sets
```

Use sets when: you need uniqueness guarantees without ordering (online users, tag membership).

### 1.8 Cache Stampede (Thundering Herd)

A cache stampede occurs when a popular key expires and many concurrent requests notice the miss simultaneously. Every request races to rebuild the value and write it back. The database receives N simultaneous expensive queries instead of one.

```
t=0: key expires
t=0.001: request 1 misses — starts DB query
t=0.002: request 2 misses — starts DB query
t=0.003: request 3 misses — starts DB query
... (100 concurrent requests, all missed, all hit DB)
t=0.200: all 100 queries finish — 100 writes to Redis, 99 are redundant
```

**Mitigations:**

1. **Probabilistic early expiry**: Before the TTL actually expires, some fraction of requests proactively refresh the cache. XFetch algorithm uses `current_time - (TTL_remaining / beta)` to decide whether to refresh.

2. **Mutex / distributed lock**: The first request to miss acquires a Redis lock, rebuilds the value, releases the lock. Other requests that miss wait or return stale data.

3. **Staggered TTLs**: Add random jitter to TTLs so keys from the same batch do not expire at the same instant.

4. **Long TTL + explicit invalidation**: If your write path always invalidates the key immediately after a DB write, you can set a very long TTL (hours). The TTL is only a safety net for missed invalidations; normal operations are served fresh via explicit invalidation.

This codebase uses the long TTL + explicit invalidation approach. A 300-second TTL on the board cache is long enough that organic expiry stampedes are rare, while write-path invalidation ensures data freshness in the common case.

---

## Part 2: Implementation Walkthrough

### 2.1 Redis Client Configuration

**File**: `src/config/redis.ts`

```typescript
import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../infrastructure/logger/Logger';

const makeClient = (): Redis => {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('connect', () => logger.info('Redis connected'));
  return client;
};

export const redis    = makeClient();
export const redisSub = makeClient();
```

Two separate clients are created: `redis` for commands and `redisSub` for pub/sub subscriptions. This split is required because a Redis client that has issued `SUBSCRIBE` or `PSUBSCRIBE` can no longer execute regular commands like `GET` or `SET` — it enters a dedicated subscription mode. Using the same client for both would cause runtime errors when issuing commands from subscribed-mode.

`lazyConnect: true` defers the TCP handshake until the first command is issued, preventing startup failures if Redis is not yet ready when the application process begins.

### 2.2 The CacheKeys Pattern: Centralizing Key Generation

**File**: `src/infrastructure/cache/CacheKeys.ts`

```typescript
export const CacheKeys = {
  boardState: (projectId: string, sprintId: string | null) =>
    `board:${projectId}:sprint:${sprintId ?? 'backlog'}`,

  boardStatePattern: (projectId: string) => `board:${projectId}:sprint:*`,

  membershipRole: (projectId: string, userId: string) =>
    `membership:${projectId}:${userId}`,

  issueEntity: (issueId: string) => `issue:${issueId}`,

  sprintIssueIndex: (projectId: string, sprintId: string | null) =>
    `idx:sprint:${projectId}:${sprintId ?? 'backlog'}`,

  statusIssueIndex: (projectId: string, statusId: string) =>
    `idx:status:${projectId}:${statusId}`,
  // ...
} as const;
```

**Why this matters:** If key construction logic is scattered across files (e.g., `"board:" + projectId` in five places), a refactor or a bug fix must touch every location. More critically, a typo in one location causes a phantom miss: the reader builds `board:proj-123:sprint:sprint-456` but the writer invalidates `board:proj_123:sprint:sprint_456`. The two keys never match; the cache is never invalidated.

Centralizing key construction in `CacheKeys` means:
- There is exactly one place to change when a key format changes
- TypeScript enforces the correct parameter types (you cannot pass an integer where a `string` is expected)
- The `as const` assertion makes the object and its function signatures immutable at the type level

Real key examples produced by this module:

```
board:proj_abc123:sprint:sprint_xyz456    # board view for a sprint
board:proj_abc123:sprint:backlog          # board view for backlog
membership:proj_abc123:user_def789        # user's role in a project
issue:issue_ghi012                        # individual issue entity
idx:sprint:proj_abc123:sprint_xyz456      # sorted set: issue IDs in a sprint
idx:status:proj_abc123:status_jkl345      # sorted set: issue IDs in a status
```

### 2.3 TTL Constants: Reasoned Values

**File**: `src/infrastructure/cache/constants.ts`

```typescript
export const CACHE_TTL = {
  MEMBERSHIP_SECONDS:    300,  // 5 min
  BOARD_SECONDS:         300,  // 5 min
  ISSUE_ENTITY_SECONDS:   60,  // 60 s
  SPRINT_LIST_SECONDS:   300,  // 5 min
  PROJECT_LIST_SECONDS:  120,  // 2 min
  INDEX_SECONDS:         600,  // 10 min
} as const;
```

The rationale behind each value:

- **MEMBERSHIP_SECONDS (300)**: RBAC role lookups happen on every authenticated request. Roles change infrequently (a project admin does not lose their role every few minutes). A 5-minute TTL keeps DB load negligible while bounding the window during which a revoked role could still be honored.

- **BOARD_SECONDS (300)**: The board view is the most expensive query in the system (multi-table JOIN). It also receives explicit invalidation on every write, so the TTL is a safety net rather than the primary freshness mechanism. 5 minutes is a generous safety net.

- **ISSUE_ENTITY_SECONDS (60)**: Individual issue entities are mutated frequently during active development (title edits, status transitions, assignee changes). The write path always performs an explicit `DEL` after updating the DB, so 60 seconds is again a safety net. The short TTL limits the blast radius of a missed invalidation.

- **INDEX_SECONDS (600)**: The sorted-set indexes are maintained write-through (new entries are added/removed on each mutation) rather than being fully rebuilt on every write. They are safe to keep for longer. 10 minutes reduces the chance of an index key being evicted between writes, which would force a full DB rebuild on the next read.

### 2.4 RedisCache Base Class

**File**: `src/infrastructure/cache/RedisCache.ts`

```typescript
export class RedisCache {
  async get<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await redis.del(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}
```

`RedisCache` abstracts the serialization/deserialization ceremony so callers deal in typed domain objects, not raw strings. The generic `get<T>` method returns `T | null`, making the possibility of a cache miss explicit in the type system — callers cannot accidentally treat a missing value as a valid result.

`invalidatePattern` is worth examining in detail. It iterates using `SCAN` rather than `KEYS`. Redis `KEYS pattern` is a blocking O(N) command that iterates the entire keyspace in a single call. On a large dataset this freezes Redis for other clients. `SCAN` iterates in small batches (the `COUNT 100` hint) using a cursor, interleaving other commands between batches. The `do...while` loop continues until Redis returns cursor `'0'`, which signals that the full keyspace has been scanned.

### 2.5 The Three Caches

#### Cache 1: MembershipCache

**File**: `src/infrastructure/cache/MembershipCache.ts`

**What it stores**: A single `ProjectRole` enum value (e.g., `"OWNER"`, `"MEMBER"`, `"VIEWER"`) keyed by `projectId + userId`.

**Why it exists**: The RBAC middleware must verify a user's role before every protected API call. Without caching, this is one DB query per request — on a high-traffic API serving 500 RPS, that is 500 unnecessary DB reads per second for data that almost never changes.

```typescript
export class MembershipCache {
  async get(projectId: string, userId: string): Promise<ProjectRole | null> {
    const val = await redis.get(CacheKeys.membershipRole(projectId, userId));
    return (val as ProjectRole) ?? null;
  }

  async set(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await redis.setex(
      CacheKeys.membershipRole(projectId, userId),
      CACHE_TTL.MEMBERSHIP_SECONDS,
      role,
    );
  }

  async del(projectId: string, userId: string): Promise<void> {
    await redis.del(CacheKeys.membershipRole(projectId, userId));
  }
}
```

Notice that `MembershipCache` stores the role string directly (not JSON-encoded), because it is already a primitive string. There is no `JSON.stringify`/`JSON.parse` wrapper here — the `set` call passes `role` directly to `redis.setex`, and the `get` call casts the raw string to `ProjectRole`. This is a small optimization: marshaling overhead is eliminated for a value that is already a string.

#### Cache 2: IssueEntityCache

**File**: `src/infrastructure/cache/IssueEntityCache.ts`

**What it stores**: Full `Issue` objects serialized as JSON, keyed by `issueId`.

**Why it exists**: The issue detail view and the board-index-assisted list path (`fetchIssuesByIds`) both need full `Issue` objects. Without an entity cache, serving a list of 50 issues requires a DB query with `IN (id1, id2, ... id50)` every time. With the entity cache, the majority of those 50 reads become cache hits.

```typescript
export class IssueEntityCache {
  async mget(issueIds: string[]): Promise<(Issue | null)[]> {
    if (!issueIds.length) return [];
    const vals = await redis.mget(...issueIds.map((id) => CacheKeys.issueEntity(id)));
    return vals.map((v) => (v ? (JSON.parse(v) as Issue) : null));
  }
}
```

`mget` is the key efficiency gain here. Rather than issuing one `GET` per issue ID (N round-trips), it issues a single `MGET` command with all keys at once (1 round-trip). Redis processes the multi-get atomically from the client's perspective; the response contains the values in the same order as the keys. Null entries in the response correspond to cache misses and are filled in from the DB in a single subsequent `IN (...)` query.

#### Cache 3: IssueIndexCache

**File**: `src/infrastructure/cache/IssueIndexCache.ts`

**What it stores**: Redis sorted sets indexed by sprint and by status, where each member is an `issueId` and the score is `createdAt` in Unix milliseconds. This enables ordered pagination without touching MySQL.

**Why sorted sets?** The board and list views need issues sorted by `createdAt DESC`. A sorted set's `ZREVRANGE` and `ZREVRANGEBYSCORE` commands return members in descending score order in O(log N + M) time, where M is the number of results returned. This is faster than a MySQL `ORDER BY createdAt DESC LIMIT ?` on a large table, and it avoids any query parsing or index scan overhead.

Two index families are maintained:

```
idx:sprint:proj_abc123:sprint_xyz456    sorted set of issue IDs in a sprint
idx:status:proj_abc123:status_jkl345    sorted set of issue IDs in a status
```

The `updateIssueStatus` method shows why pipelines matter:

```typescript
async updateIssueStatus(
  projectId: string,
  issueId: string,
  fromStatusId: string,
  toStatusId: string,
  score: number,
): Promise<void> {
  await redis
    .pipeline()
    .zrem(CacheKeys.statusIssueIndex(projectId, fromStatusId), issueId)
    .zadd(CacheKeys.statusIssueIndex(projectId, toStatusId), score, issueId)
    .exec();
}
```

Without a pipeline, this would be two sequential round-trips: remove from old status, add to new status. With `.pipeline()`, both commands are batched into a single TCP packet and executed in one round-trip. The `exec()` call sends the batch and awaits the combined response.

### 2.6 The BoardView Read Model

**File**: `src/read-models/BoardView.ts`

`BoardView` has three nested layers:

```
BoardView
  └── columns: BoardColumn[]
        └── issues: BoardIssue[]
```

Each layer omits fields that the board UI does not need:
- `BoardIssue` omits `createdAt`, `updatedAt`, `deletedAt`, `reporterId`, `description`, `sprintId`, and `projectId` — the board card only shows title, assignee, priority, story points, and labels
- `BoardColumn` includes `wipLimit` (for WIP limit indicators) and `position` (for column ordering)
- `BoardView` includes `cachedAt` — a timestamp that lets the frontend display "data may be up to N seconds old"

All fields are `readonly`. This is a pure data transfer shape; there are no methods, no ORM decorators, no circular references. It can be `JSON.stringify`'d without any configuration.

### 2.7 IssueQueryService: The Read Path

**File**: `src/modules/issues/IssueQueryService.ts`

#### getBoardView: Cache Read Path

```typescript
async getBoardView(projectId: string, sprintId: string | null): Promise<BoardView> {
  const cacheKey = CacheKeys.boardState(projectId, sprintId);
  const cached = await redisCache.get<BoardView>(cacheKey);
  if (cached) return cached;          // HIT — done in ~0.5 ms

  // MISS — query DB
  const [statuses, issues] = await Promise.all([
    this.workflowRepo.findStatusesByProject(projectId),
    AppDataSource.getRepository(Issue)
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.assignee', 'assignee')
      // ... filters ...
      .getMany(),
  ]);

  // Side-effect: warm the sorted-set indexes from this DB result
  issueIndexCache.populateFromIssues(projectId, sprintId, issues).catch(() => {});

  const boardView: BoardView = {
    projectId,
    sprintId,
    cachedAt: new Date().toISOString(),
    columns: statuses.map((s) => ({
      // ... map issues to BoardIssue shape ...
    })),
  };

  await redisCache.set(cacheKey, boardView, CACHE_TTL.BOARD_SECONDS);
  return boardView;
}
```

The `populateFromIssues` call is a side-effect opportunistically fired after a DB miss. It writes the sprint/status sorted-set indexes while the data is already in memory. If this call fails (e.g., a transient Redis error), the `.catch(() => {})` swallows the error — the primary response path is not affected. The indexes will simply be built on the next access.

#### list: Index-Assisted Pagination

```typescript
async list(projectId, filters, pagination): Promise<CursorPage<Issue>> {
  const sprintOnly = filters.sprintId !== undefined
    && !filters.statusId && !filters.assigneeId && !filters.type;

  if (sprintOnly) {
    const page = await issueIndexCache.getSprintIssueIds(
      projectId, filters.sprintId ?? null, pagination.cursor, pagination.limit,
    );

    if (page) {
      const items = await this.fetchIssuesByIds(page.ids);
      // ... build cursor ...
      return { items, nextCursor, hasMore: page.hasMore };
    }
    // Index cold — fall through to DB
  }

  return this.listFromDb(projectId, filters, pagination);
}
```

The fast path: `ZREVRANGEBYSCORE` returns page IDs → `MGET` fetches entities from the entity cache → a targeted `IN (...)` query fetches only the missed entities. The slow path: a full `WHERE ... ORDER BY createdAt DESC LIMIT ?` query, which also opportunistically warms the sprint index for future requests.

#### fetchIssuesByIds: Multi-Cache Partial Hit

```typescript
private async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
  const cached    = await issueEntityCache.mget(ids);
  const missingIds = ids.filter((_, i) => !cached[i]);

  let dbIssues: Issue[] = [];
  if (missingIds.length) {
    dbIssues = await AppDataSource.getRepository(Issue)
      .createQueryBuilder('i')
      // ...
      .where('i.id IN (:...ids)', { ids: missingIds })
      .getMany();
  }

  // Merge: preserve original order
  const byId = new Map(dbIssues.map((i) => [i.id, i]));
  return ids
    .map((id, idx) => (cached[idx] as Issue | null) ?? byId.get(id))
    .filter((i): i is Issue => !!i);
}
```

This demonstrates a partial-hit pattern: some IDs hit the cache, others miss. Only the missed IDs go to the DB, and the final array is reassembled in the original sorted order.

### 2.8 IssueCommandService: The Write Path and Invalidation

**File**: `src/modules/issues/IssueCommandService.ts`

`IssueCommandService` is a pure write service: it mutates the DB and publishes domain events. Cache invalidation is handled by the manager layer (not shown here but referenced in ADR-004), which listens to domain events. The command service returns enough context for the manager to perform targeted invalidation.

For example, `transition` returns both the updated issue and the pre-transition `fromStatusId`:

```typescript
async transition(
  issueId: string,
  toStatusId: string,
  actorId: string,
  correlationId: string,
): Promise<{ issue: Issue; fromStatusId: string }> {
  const issue = await this.issueRepo.findById(issueId, ['status']);
  if (!issue) throw new NotFoundError('Issue', issueId);
  const fromStatusId = issue.statusId;
  const updated = await this.workflowEngine.transition(issue, toStatusId, actorId, correlationId);
  return { issue: updated, fromStatusId };
}
```

The manager layer uses `fromStatusId` and `toStatusId` to call `issueIndexCache.updateIssueStatus(...)` with the two exact sorted-set keys that need updating, rather than invalidating entire project-wide indexes.

Similarly, `delete` returns the pre-delete snapshot:

```typescript
async delete(issueId: string): Promise<Issue> {
  const issue = await this.issueRepo.findById(issueId);
  if (!issue) throw new NotFoundError('Issue', issueId);
  await this.issueRepo.softDelete(issueId);
  return issue;
}
```

Returning the snapshot means the caller knows the `projectId`, `sprintId`, and `statusId` of the deleted issue — enough to call `issueIndexCache.removeIssue(issue)` and `issueEntityCache.del(issueId)` with exact keys.

### 2.9 ASCII Data Flow Diagrams

#### Cache Read Path (getBoardView, cache HIT)

```
Client
  │
  ▼
HTTP Handler
  │
  ▼
IssueQueryService.getBoardView(projectId, sprintId)
  │
  ├─► RedisCache.get("board:proj_abc:sprint:sprint_xyz")
  │         │
  │         └─► Redis GET ──► [HIT] ──► return JSON string
  │                                           │
  │                                    JSON.parse(raw)
  │                                           │
  └───────────────────────────────────────────┘
                                              │
                                       BoardView object
                                              │
                                              ▼
                                       HTTP Response (≈ 0.5 ms)
```

#### Cache Miss + DB Fallback + Cache Population

```
Client
  │
  ▼
IssueQueryService.getBoardView(projectId, sprintId)
  │
  ├─► Redis GET ──► [MISS] (key expired or never set)
  │
  ├─► MySQL Query (issues + statuses JOIN) ──► rows (~20–50 ms)
  │
  ├─► issueIndexCache.populateFromIssues(...)    [fire-and-forget]
  │         └─► Redis PIPELINE: ZADD × N, EXPIRE
  │
  ├─► Build BoardView object (in memory)
  │
  ├─► Redis SETEX "board:proj_abc:sprint:sprint_xyz" 300 <json>
  │
  └─► Return BoardView (~25 ms total)
```

#### Write Path + Cache Invalidation (status transition)

```
Client
  │
  ▼
HTTP PUT /issues/:id/transition
  │
  ▼
IssueCommandService.transition(issueId, toStatusId)
  │
  ├─► DB READ: find issue (gets fromStatusId)
  ├─► DB WRITE: update issue.statusId in MySQL
  ├─► Publish IssueTransitioned domain event
  └─► Return { issue, fromStatusId }
  │
  ▼
Manager layer handles invalidation:
  │
  ├─► issueEntityCache.del(issueId)
  │         └─► Redis DEL "issue:issue_ghi012"
  │
  ├─► issueIndexCache.updateIssueStatus(projectId, issueId, fromStatusId, toStatusId, score)
  │         └─► Redis PIPELINE:
  │                 ZREM "idx:status:proj_abc:status_old"  issue_ghi012
  │                 ZADD "idx:status:proj_abc:status_new"  <score>  issue_ghi012
  │
  └─► redisCache.del(CacheKeys.boardState(projectId, sprintId))
            └─► Redis DEL "board:proj_abc:sprint:sprint_xyz"
```

### 2.10 What Happens on a Cold Start

When the application starts fresh or Redis is flushed, all caches are empty. The sequence for the first board view request is:

1. `GET board:proj_abc:sprint:sprint_xyz` → nil (miss)
2. MySQL query executes, returns all issues for the sprint
3. `issueIndexCache.populateFromIssues(...)` bulk-writes sorted-set indexes to Redis
4. `BoardView` object is assembled
5. `SETEX board:proj_abc:sprint:sprint_xyz 300 <json>` stores the full board
6. Response returned

All subsequent board requests within 300 seconds (or until a write invalidates the key) return via the fast Redis `GET` path. If between requests an issue is updated, the manager layer deletes the board key, and the next board request triggers a fresh DB query and re-population.

---

## Key Takeaways

- **Cache hit ratio is the metric that matters.** A cache with a 50% hit ratio is saving half the DB load; a cache with a 95% hit ratio is saving 95%. Instrument your hit ratio and set an alert if it drops.
- **Cache-Aside puts the application in control.** The application reads from the cache, falls back to the DB on a miss, and populates the cache. This is the most flexible pattern because the application can decide what to cache, with what TTL, and how to invalidate.
- **Always delete, never update on writes.** Setting a potentially stale value in the cache on a write creates a race condition window. Deleting the key forces the next reader to fetch fresh data from the authoritative source.
- **TTLs are a safety net, not the primary freshness mechanism.** Explicit invalidation on writes is your first line of defense against stale reads. TTLs protect against bugs in the invalidation path.
- **Centralize key construction.** Magic strings scattered across files cause subtle bugs where a reader and a writer use slightly different key formats and the cache is never actually used. A typed `CacheKeys` module with a single function per cache entry eliminates this class of bug.
- **Use the right Redis data structure.** A sorted set is not a substitute for a string; using a string for an ordered index would require deserializing a full array on every read. Matching data structure to access pattern is fundamental to getting value from Redis.
- **Batch Redis calls with pipelines and MGET.** Ten sequential `GET` commands have ten times the latency of one `MGET` command returning ten values. Use `MGET`/`HMGET` and `pipeline()` whenever you know all the keys upfront.
- **Prefer scoped invalidation over broad invalidation.** Invalidating `board:proj_abc:sprint:sprint_xyz` only touches the affected sprint's board. Invalidating `board:proj_abc:sprint:*` (via `SCAN` + `DEL`) is more expensive and affects unrelated sprints. Reserve pattern-based invalidation for cases where you genuinely do not know which specific keys to delete.

---

## Further Reading

- **"Designing Data-Intensive Applications"** by Martin Kleppmann (O'Reilly, 2017) — Chapter 5 covers replication and consistency models that underpin cache invalidation theory. Chapter 11 covers event-driven architectures related to CQRS.
- **Redis documentation: Data types** — https://redis.io/docs/data-types/ — The official reference for strings, hashes, lists, sets, and sorted sets, including complexity guarantees for each command.
- **"Caching Best Practices" — AWS Architecture Blog** by Fatima Sarah Khalid (2022) — Covers Cache-Aside, Write-Through, and Write-Behind patterns with worked AWS examples; the trade-offs generalize to any Redis deployment.
- **"An Introduction to Redis Data Types and Abstractions"** — https://redis.io/docs/data-types/tutorial/ — A hands-on walkthrough of when to use each structure, written by the Redis core team.
- **"CQRS" by Martin Fowler** — https://martinfowler.com/bliki/CQRS.html — The canonical short reference for Command Query Responsibility Segregation, which motivates the separation between `IssueCommandService` (write) and `IssueQueryService` (read) in this codebase.
