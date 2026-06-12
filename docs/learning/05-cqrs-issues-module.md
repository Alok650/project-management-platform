# CQRS — Issues Module

## What You'll Learn

- What CQRS is, why it exists, and the Command Query Separation principle it builds on
- What optimistic locking is, how the `@VersionColumn` pattern prevents lost updates, and the exact race condition it closes
- What a read model is and why it has different shape requirements than the write model
- The trade-offs of CQRS: when it is the right tool and when it adds unjustified complexity
- How project-scoped issue keys (e.g. `PROJ-42`) are generated atomically and why naive approaches fail under concurrency
- The full write path: `IssueController` → `IssueManager` → `IssueCommandService` → `IssueRepository` → DB → event publish → cache invalidation
- The full read path: `IssueController` → `IssueManager` → `IssueQueryService` → board cache → index cache → entity cache → `BoardView`
- Why `IssueManager` exists as a façade and what would break without it
- How the two-level cache (index + entity) eliminates redundant DB queries on the read path

---

## Part 1 — Theory

### 1.1 Command Query Separation (CQS)

In 1988, Bertrand Meyer articulated a deceptively simple principle while designing the Eiffel programming language:

> **A function should either change state (a command) or return data (a query), but never both.**

The violation of this rule is so common it has a name: a function that mutates state and also returns the new state (or something derived from it) is called a "command that pretends to be a query." Stack's `pop()` in most imperative languages is the canonical example — it removes the top element and returns it. Meyer argued this conflation makes programs harder to reason about because calling a function twice produces different results.

Here is a contrasting example in pseudocode:

```typescript
// Violation: pop() both mutates the stack AND returns data
const value = stack.pop(); // reading AND writing at once

// CQS-compliant:
const value = stack.peek(); // pure query, no side effects
stack.pop();                // pure command, returns void
```

This seems pedantic until you are reading code written by someone else. A function called `getNextSequenceNumber()` looks like a read — you expect to call it safely, multiple times, for logging or debugging. If it secretly increments a counter in the database on each call, every innocent read changes the system state. Bugs like this are extremely hard to trace.

CQS at the function level is good hygiene. **CQRS (Command Query Responsibility Segregation)** is the architectural application of the same idea: separate the **objects** (classes, services, sometimes entire subsystems) that handle writes from those that handle reads.

### 1.2 What Is CQRS?

CQRS was popularised by Greg Young and Udi Dahan around 2009-2010, building on domain-driven design (DDD) ideas from Eric Evans. The key insight is that in most production systems, reads and writes have radically different characteristics:

| Dimension | Writes (Commands) | Reads (Queries) |
|---|---|---|
| Frequency | Infrequent | Dominant (often 90%+ of traffic) |
| Correctness requirement | High — must not lose updates | Lower — slight staleness is usually acceptable |
| Data shape needed | Normalised domain model | Denormalised view model (flat, joined, aggregated) |
| Caching | Dangerous — stale writes corrupt state | Safe — short TTLs acceptable |
| Scaling direction | Vertical (single writer, ACID) | Horizontal (read replicas, caches, CDNs) |

A single service handling both concerns must compromise. If you optimise for read performance (caching, denormalised DTOs), you add complexity to the write path. If you optimise for write correctness (locking, transactions, normalised entities), you slow down reads.

CQRS resolves this by splitting the service in two:

```
┌─────────────────────────────────┐
│           CLIENT REQUEST        │
└──────────────┬──────────────────┘
               │
       ┌───────▼────────┐
       │   Controller   │
       └───────┬────────┘
               │
       ┌───────▼────────┐
       │    Manager     │  ← façade / orchestrator
       └──┬──────────┬──┘
          │          │
  ┌───────▼──┐  ┌────▼───────┐
  │ Command  │  │   Query    │
  │ Service  │  │  Service   │
  └───────┬──┘  └────┬───────┘
          │          │
      Writes       Reads
     (DB, events)  (DB, cache)
```

The command service owns writes. The query service owns reads. Neither knows about the other's concerns.

### 1.3 Optimistic Locking and the Lost Update Problem

Imagine two engineers, Alice and Bob, both have the detail view of issue `PROJ-42` open. The issue's title is "Login page broken". Bob is about to update the description. Alice is about to change the assignee. They both click Save within one second of each other.

Without any concurrency control, here is what happens:

```
Time  Alice (client)              Bob (client)            Database
────  ─────────────────────────  ─────────────────────   ─────────────────────
T0    Reads issue (v1)                                    version=1
T1                                Reads issue (v1)        version=1
T2    PATCH {assignee: 'alice'}                           UPDATE → version=2
T3                                PATCH {desc: '...'}     UPDATE → version=2
                                  (Bob sends v1 data,
                                   Alice's change is
                                   silently overwritten)
```

Alice's assignee change at T2 is gone. Bob's write at T3 wrote a full snapshot of the object that was stale — it still had the original assignee. This is called a **lost update** and it is one of the most common correctness bugs in collaborative web applications.

**Optimistic locking** prevents this without using pessimistic database locks (which would require a row-level lock to be held while a user fills in a form — possibly for minutes). Instead, every row carries an integer **version counter**. The invariant is:

> You may only write version N+1 if the current version in the database is still N.

The database enforces this as a conditional UPDATE:

```sql
UPDATE issues
SET    title = ?, version = 3
WHERE  id    = 'abc'
AND    version = 2;  -- "I believe the current version is 2"
```

If the row has already been updated by someone else (so `version` is now 3), `WHERE version = 2` matches zero rows. The ORM detects this and throws an error, which the application surfaces as HTTP 409 Conflict. The client is told: "reload and try again."

With optimistic locking, the timeline becomes:

```
Time  Alice                    Bob                    Database
────  ──────────────────────   ─────────────────────  ──────────────
T0    Read issue (v=1)                                version=1
T1                              Read issue (v=1)       version=1
T2    PATCH {assignee, v=1}                            UPDATE ok → v=2
T3                              PATCH {desc, v=1}      WHERE v=1 → 0 rows
                                ← 409 Conflict: reload
```

Bob gets a 409. He reloads, sees version 2 (which includes Alice's assignee change), and re-applies his description change as version 3. No data is lost.

### 1.4 How TypeORM's `@VersionColumn` Implements Optimistic Locking

TypeORM makes optimistic locking declarative. In `src/models/Issue.ts` at line 64:

```typescript
/** Incremented automatically by TypeORM on every save — used for optimistic locking */
@VersionColumn()
version!: number;
```

When you call `em.save(Issue, { ...issue, version: clientVersion })`, TypeORM generates:

```sql
UPDATE issues
SET    title   = ?,
       version = version + 1   -- TypeORM increments automatically
WHERE  id      = ?
AND    version = ?;             -- the clientVersion you passed
```

If zero rows are affected (because `version` no longer matches), TypeORM throws `OptimisticLockVersionMismatchError`. The `IssueCommandService.update()` method at lines 116-124 catches this by name and re-throws it as a domain-level `ConflictError` with the current server version so the client knows which version to use when retrying:

```typescript
catch (err: unknown) {
  if (err instanceof Error && err.name === 'OptimisticLockVersionMismatchError') {
    const current = await this.issueRepo.findById(issueId);
    throw new ConflictError(
      'Issue was modified by another user. Please retry with the latest version.',
      current?.version,
    );
  }
  throw err;
}
```

This is the correct pattern: catch the ORM-specific error by name (not instance, since it crosses module boundaries), fetch the fresh version so the response body tells the client exactly which version to use next, then throw a domain error that the HTTP layer maps to 409.

### 1.5 Read Models — Why the Read Shape Differs From the Write Shape

The **write model** (the `Issue` entity) is normalised. It stores foreign keys (`statusId`, `assigneeId`) not the full status name or assignee avatar URL. This is correct for writes — normalisation prevents update anomalies. If an assignee changes their display name, you update one `users` row and every issue automatically reflects it.

But the board UI does not care about normalisation. It needs a flat structure grouped by status column, with each card showing an assignee avatar, a status colour, and a story-point badge. If the write model were used directly, every board render would require:

```sql
SELECT i.*, s.name, s.color, u.display_name, u.avatar_url
FROM   issues i
JOIN   issue_statuses s ON s.id = i.status_id
JOIN   users          u ON u.id = i.assignee_id
WHERE  i.project_id = ?
AND    i.sprint_id  = ?
```

...and then the application would pivot the result into columns. That is fine for occasional queries. At 100+ concurrent viewers during a sprint planning session (the scenario in ADR-002), this becomes unacceptable DB load.

A **read model** is a pre-computed, denormalised representation optimised for a specific view. In this codebase the read model is `BoardView` (referenced in `IssueQueryService` at line 12):

```typescript
import type { BoardView } from '../../read-models/BoardView';
```

`BoardView` is a flat JSON structure with columns already grouped, assignee names already resolved, and status metadata already embedded. It is computed once on cache miss and then served directly from Redis for all subsequent requests until a write invalidates it.

The read model is not persisted in the main database. It is a projection — a derived view built from the authoritative write model.

### 1.6 Trade-offs of CQRS

CQRS is a powerful pattern with real costs. Use it deliberately.

**When CQRS is essential:**
- The read and write traffic profiles are radically different (hot reads, infrequent writes)
- Read queries need denormalised projections that would be awkward to compute inline on every request
- Write correctness requires explicit concurrency control (optimistic or pessimistic locking)
- The domain is complex enough that a single "God service" would become a maintenance liability

**When CQRS is overkill:**
- A CRUD screen with simple selects and inserts (user profile page, settings forms)
- No meaningful concurrency — only one user can ever edit a given record
- The team is small and the added file count creates more confusion than clarity
- You do not have Redis or a caching layer — CQRS without a read optimisation story is just extra files

The ADR-002 decision record explicitly notes that the issues module has a "sharply different performance profile" between reads and writes, justifying the split. For a simpler module like `ProjectRepository`, a single service is used — CQRS is not applied uniformly across the codebase.

### 1.7 Issue Keys — Why Concurrent Generation Is Hard

An issue key like `PROJ-42` is a human-readable, project-scoped sequential identifier. Users reference them in commit messages, Slack conversations, and documentation. They must be:

1. **Sequential** — `PROJ-1`, `PROJ-2`, `PROJ-3`...
2. **Unique** — no two issues in a project ever share a key
3. **Gap-free** (desirable) — no `PROJ-3` if `PROJ-2` and `PROJ-1` exist
4. **Correct under concurrent inserts** — two simultaneous `POST /issues` requests must not both receive `PROJ-42`

The naive approach fails immediately:

```sql
-- Thread A and Thread B both execute this at T=0
SELECT MAX(counter) FROM issues WHERE project_id = 'proj-1';
-- Both read counter = 41
-- Both compute next = 42
-- Both INSERT with key = PROJ-42
-- UNIQUE constraint violation, or worse, duplicate keys if no constraint
```

`SELECT MAX()` is not atomic with the subsequent `INSERT`. Between the read and the write, another connection can read the same maximum and compute the same next value.

The correct solution is an **atomic increment** in the database — a single statement that reads the counter and increments it in one indivisible operation, using the database's row-level lock on the counter row. MySQL's `ON DUPLICATE KEY UPDATE` with `LAST_INSERT_ID(expr)` provides exactly this. The full explanation is in section 2.6.

---

## Part 2 — Implementation Walkthrough

### 2.1 Full Write Path: Creating an Issue

Here is the complete call chain for `POST /api/v1/projects/:projectId/issues`:

```
IssueController.create()
    │
    ▼
IssueManager.create()               ← façade, wires together services + cache ops
    │
    ▼
IssueCommandService.create()        ← write-only: validation, key gen, DB save, event
    │   ├── ProjectRepository.findById()      ← verify project exists
    │   ├── WorkflowRepository.findStatusesByProject()  ← find default TODO status
    │   ├── IssueKeyGenerator.next()          ← atomic counter increment
    │   ├── IssueRepository.save()            ← INSERT into issues table
    │   └── eventBus.publish(IssueCreated)    ← domain event
    │
    ▼  (back in IssueManager)
Promise.allSettled([
    redisCache.invalidatePattern(boardStatePattern),  ← bust board cache for project
    issueIndexCache.addIssue(issue)                   ← warm sprint+status sorted-set
])
    │
    ▼
HTTP 201 { data: Issue }
```

Key design points in each step:

**`IssueController.create()` (lines 11-19 of `IssueController.ts`):** The controller is intentionally thin. It extracts `projectId` from `ctx.params`, the body from `ctx.request.body`, and the acting user from `ctx.state.user.id` (populated by auth middleware). It calls `manager.create()` and sets the status to 201. It contains zero business logic.

**`IssueCommandService.create()` (lines 34-69 of `IssueCommandService.ts`):** The `statusId` default-resolution logic lives here. If the caller omits `statusId`, the service fetches the project's workflow statuses and picks the first one in the `TODO` category. This is a business rule — it belongs in the command service, not the controller.

**`IssueRepository.save()` (line 26 of `IssueRepository.ts`):** Accepts an optional `EntityManager` for transaction-aware saves. When called from `IssueCommandService.create()`, no `em` is passed, so it uses the default data source repo — a simple `INSERT`.

**`eventBus.publish(IssueCreated)` (lines 61-66 of `IssueCommandService.ts`):** The event is published after the DB save succeeds. This is correct sequencing — you should never publish an event for a write that has not been committed. Downstream consumers (notification service, audit log) will process this event asynchronously.

**`IssueManager.create()` (lines 28-39 of `IssueManager.ts`):** After the command service returns the saved issue, the manager runs cache maintenance with `Promise.allSettled()`. Using `allSettled` rather than `Promise.all` is deliberate — a Redis failure must not cause the HTTP response to fail. The issue was already saved to the DB; cache state is secondary.

### 2.2 Full Read Path: Loading a Board

Here is the call chain for `GET /api/v1/projects/:projectId/board?sprintId=<uuid>`:

```
IssueController.getBoard()
    │
    ▼
IssueManager.getBoard()
    │
    ▼
IssueQueryService.getBoardView(projectId, sprintId)
    │
    ├── redisCache.get(CacheKeys.boardState(projectId, sprintId))
    │       │
    │    HIT ──────────────────────────────────────── return BoardView immediately
    │       │
    │    MISS
    │       │
    ├── Promise.all([
    │       WorkflowRepository.findStatusesByProject(),  ← column definitions
    │       QueryBuilder on issues + assignee JOIN       ← issue data for sprint
    │   ])
    │       │
    ├── issueIndexCache.populateFromIssues()  ← side-effect: warm sorted-set indexes
    │       │
    ├── groupBy(issues, 'statusId')           ← lodash: pivot rows into columns
    │       │
    ├── Build BoardView object                ← denormalised read model
    │       │
    └── redisCache.set(boardKey, boardView, TTL=300s)
            │
            ▼
    return BoardView
            │
            ▼
HTTP 200 { data: BoardView }
```

The board query (lines 43-56 of `IssueQueryService.ts`) selects only the fields the board UI needs:

```typescript
.select([
  'i.id', 'i.issueKey', 'i.type', 'i.title', 'i.priority',
  'i.storyPoints', 'i.statusId', 'i.parentId', 'i.labels', 'i.version',
  'i.createdAt',
  'assignee.id', 'assignee.displayName',
])
```

Notice what is absent: `i.description`, `i.reporterId`, `i.deletedAt`, `i.updatedAt`. The board card does not need these. Selecting only the required columns reduces data transfer from MySQL and reduces the size of the Redis-cached blob.

### 2.3 The Two-Level Cache for Paginated Lists

When loading a sprint's issue list (`GET /projects/:id/issues?sprintId=...`), `IssueQueryService.list()` uses a two-level cache optimisation (lines 129-155):

**Level 1 — Sprint Index Cache (sorted set of IDs):**

`issueIndexCache` stores a Redis sorted set per sprint, where each member is an issue ID and the score is the `createdAt` timestamp in milliseconds. This allows range queries (`ZRANGEBYSCORE`) to return a cursor-paginated list of IDs without touching MySQL at all.

**Level 2 — Entity Cache (individual issue JSON):**

`issueEntityCache` stores each `Issue` as a JSON blob keyed by UUID. Once `issueIndexCache` returns a page of IDs, `fetchIssuesByIds()` (lines 161-183) attempts to serve them from the entity cache, only going to MySQL for the IDs that are missing:

```typescript
const cached = await issueEntityCache.mget(ids);
const missingIds = ids.filter((_, i) => !cached[i]);

let dbIssues: Issue[] = [];
if (missingIds.length) {
  dbIssues = await AppDataSource.getRepository(Issue)
    .createQueryBuilder('i')
    // ...
    .where('i.id IN (:...ids)', { ids: missingIds })
    .getMany();
}

// Merge cache hits and DB results in original order
const byId = new Map(dbIssues.map((i) => [i.id, i]));
return ids
  .map((id, idx) => (cached[idx] as Issue | null) ?? byId.get(id))
  .filter((i): i is Issue => !!i);
```

A partial cache miss (e.g. 20 IDs requested, 15 in entity cache, 5 missing) results in a single `WHERE id IN (...)` query for only the 5 missing IDs. The results are re-merged with the cached items in the original sorted-set order before being returned. This is important — the original order (by `createdAt` score) must be preserved, not the order that MySQL returns the `IN` results.

**What happens when the sprint index is cold:**

If `issueIndexCache.getSprintIssueIds()` returns `null` (cache miss at the index level), execution falls through to `listFromDb()`, which runs a full cursor-paginated MySQL query. As a side-effect, the result is used to populate the sprint index (`issueIndexCache.populateFromIssues()`), warming the cache for the next request.

### 2.4 IssueManager as the Façade

The `IssueManager` class (`IssueManager.ts`) is the only thing `IssueController` knows about. The controller has no imports of `IssueCommandService`, `IssueQueryService`, `IssueRepository`, or any cache class. This is a deliberate design choice.

**What the façade provides:**

1. **Single construction point.** `IssueManager` constructs `IssueRepository`, `ProjectRepository`, `WorkflowRepository`, and both services in its constructor (lines 18-25). The controller instantiates one object, not five.

2. **Cache orchestration co-located with writes.** After every command, the manager executes the cache invalidation logic. This means the command service remains pure — it writes to the DB and publishes an event. It does not know that a Redis board cache exists. If the caching strategy changes (different key patterns, additional caches), only `IssueManager` needs updating.

3. **Return-value coordination.** `IssueCommandService.transition()` returns both the updated issue and the `fromStatusId` (lines 133-144). The command service calculates `fromStatusId` because it already loaded the pre-transition issue — returning it avoids a second DB fetch in the manager. The manager uses `fromStatusId` to call `issueIndexCache.updateIssueStatus()` with precise `ZREM + ZADD` semantics rather than invalidating the entire index.

4. **Hides the CQRS split from the controller.** The controller calls `manager.getBoard()`, `manager.create()`, `manager.transition()`. It treats the manager as a single cohesive service. The CQRS split is an implementation detail the controller does not need to know about.

If `IssueManager` did not exist, the controller would need to know which service handles each operation, manage cache invalidation after every write, and construct all the repository dependencies itself. The controller would become a coordinator rather than an HTTP adapter.

### 2.5 Deep Dive: IssueCommandService Methods

**`create()` (lines 34-69):**

Validates the project exists, resolves the default status if omitted, calls `IssueKeyGenerator.next()` (see section 2.6), saves the issue, and publishes `IssueCreated`. The `labels` field is explicitly defaulted to `[]` if not provided (line 57) — this prevents a null JSON column which would need NULL-coalescing everywhere on the read path.

**`update()` (lines 81-126):**

Requires `version` in the `data` payload — this is enforced by the TypeScript type `Partial<Issue> & { version: number }`. The `omit(data, ['version'])` call on line 90 strips the version field before spreading `changes` onto the issue entity — because `version` in the UPDATE payload is the version the client is asserting, not the new version to write. TypeORM increments the version column automatically.

The `sprintChanged` check (lines 91-92) compares the incoming `sprintId` to the pre-update value. If they differ, both an `IssueUpdated` and an `IssueMoved` event are published. The manager layer uses `IssueMoved` to invalidate the correct sprint index.

**`transition()` (lines 133-144):**

Delegates to `WorkflowEngine.canTransition()` + transition logic. The transition method returns both the updated issue and `fromStatusId` — a small but important API design. The manager needs `fromStatusId` to execute a precise ZREM on the old status sorted-set and a ZADD on the new status sorted-set. If `transition()` returned only the updated issue, the manager would need to reload the pre-update issue from DB or cache to learn the old status.

**`delete()` (lines 150-155):**

Uses soft-delete (`issueRepo.softDelete()`), which sets `deletedAt` rather than removing the row. TypeORM's `@DeleteDateColumn` means queries without `.withDeleted()` will automatically exclude soft-deleted rows. The method returns the pre-deletion snapshot so the manager can call `issueIndexCache.removeIssue(issue)` — the issue object contains `projectId`, `sprintId`, and `statusId`, which are needed to target the correct sorted-set keys.

### 2.6 Deep Dive: IssueKeyGenerator

The full implementation in `IssueKeyGenerator.ts`:

```typescript
async next(projectId: string, projectKey: string): Promise<string> {
  return AppDataSource.transaction(async (em) => {
    await em.query(
      `INSERT INTO issue_key_counters (project_id, counter) VALUES (?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE counter = LAST_INSERT_ID(counter + 1)`,
      [projectId],
    );
    const [row] = await em.query(`SELECT LAST_INSERT_ID() AS counter`);
    return `${projectKey}-${(row as { counter: number }).counter}`;
  });
}
```

**Why this is correct:**

`INSERT ... ON DUPLICATE KEY UPDATE` is an atomic operation in MySQL. When the row for `projectId` does not exist yet, it inserts with `counter = LAST_INSERT_ID(1)` (i.e. 1). On subsequent calls, it updates `counter = LAST_INSERT_ID(counter + 1)`, which both increments the counter and sets the connection-local `LAST_INSERT_ID` register to the new value in one atomic statement.

The `SELECT LAST_INSERT_ID()` on the next line reads the value that was set by this connection's previous statement. MySQL guarantees that `LAST_INSERT_ID()` is connection-local — two concurrent connections each get their own `LAST_INSERT_ID` value.

**Why the transaction matters:**

The comment at lines 14-17 explains: both queries must run on the same database connection so that `SELECT LAST_INSERT_ID()` reads the value written by this connection's INSERT/UPDATE, not another connection's. `AppDataSource.transaction()` holds a single connection for the callback duration. Without the transaction, if the connection pool released and reacquired a connection between the two queries, the `SELECT LAST_INSERT_ID()` would read the register of a different connection — potentially returning a value set by another concurrent request.

**Why `SELECT MAX()` fails:**

```sql
-- Thread A:  SELECT MAX(counter) → 41
-- Thread B:  SELECT MAX(counter) → 41  (A hasn't inserted yet)
-- Thread A:  INSERT counter = 42
-- Thread B:  INSERT counter = 42        ← UNIQUE KEY violation or collision
```

`SELECT MAX()` followed by `INSERT` is two separate statements. Any number of threads can observe the same maximum between those two statements. The atomic `ON DUPLICATE KEY UPDATE` closes this window entirely.

### 2.7 Deep Dive: Status Transition Flow

When a user drags an issue card from the "In Progress" column to the "Done" column, the client sends:

```http
POST /api/v1/issues/:issueId/transitions
Content-Type: application/json

{ "toStatusId": "uuid-of-done-status" }
```

The full flow:

```
IssueController.transition()
    │  Extracts issueId, toStatusId, actorId, correlationId
    ▼
IssueManager.transition()
    │
    ▼
IssueCommandService.transition()
    │
    ├── IssueRepository.findById(issueId, ['status'])
    │       Records fromStatusId = issue.statusId
    │
    ├── WorkflowEngine.transition(issue, toStatusId, actorId, correlationId)
    │       ├── canTransition(fromStatus, toStatus) — validates the transition
    │       │   is allowed by the workflow rules for this project
    │       ├── UPDATE issues SET status_id = toStatusId, version = version + 1
    │       │   WHERE id = issueId AND version = currentVersion
    │       └── eventBus.publish(IssueTransitioned)
    │
    └── Returns { issue: updated, fromStatusId }
            │
            ▼ (back in IssueManager)
    Promise.allSettled([
        redisCache.invalidatePattern(boardStatePattern),   ← bust full board cache
        issueEntityCache.del(issueId),                     ← bust entity cache
        issueIndexCache.updateIssueStatus(               ← precise sorted-set update
            projectId, issueId,
            fromStatusId, toStatusId,
            createdAt timestamp
        )
    ])
```

**Why the precise ZREM+ZADD matters:**

The `issueIndexCache` stores a sorted set per status column (score = `createdAt`). When an issue transitions from status A to status B, a naive approach would delete the entire sprint index and let it rebuild lazily on the next board load. Instead, `updateIssueStatus()` does a targeted:

```
ZREM sprint:<projectId>:<sprintId>:status:<fromStatusId>  <issueId>
ZADD sprint:<projectId>:<sprintId>:status:<toStatusId>    <score> <issueId>
```

This is a constant-time operation regardless of how many issues are in the sprint. A full index rebuild would be O(n) where n is the number of issues in the sprint.

### 2.8 ASCII Diagrams

**Write path (create issue):**

```
HTTP POST /projects/:id/issues
          │
          ▼
    ┌────────────┐
    │IssueCtrl   │  extract params, body, userId
    └──────┬─────┘
           │
           ▼
    ┌────────────┐
    │IssueManager│  orchestrate + cache ops
    └──────┬─────┘
           │
           ▼
    ┌─────────────────┐
    │IssueCommandSvc  │
    │  - find project │
    │  - default status│
    │  - key gen      │
    │  - save to DB   │
    │  - publish event│
    └──────┬──────────┘
           │
     ┌─────▼─────┐
     │   MySQL   │  INSERT issues
     └───────────┘
           │
           ▼ (returns saved Issue)
    ┌─────────────────────────────────────────────┐
    │  IssueManager cache ops (Promise.allSettled)│
    │  ┌──────────────────────────────────────────┤
    │  │ redisCache.invalidatePattern(board:proj) │
    │  │ issueIndexCache.addIssue(issue)          │
    └──┴──────────────────────────────────────────┘
           │
     HTTP 201 { data: Issue }
```

**Read path (board view, cache hit vs miss):**

```
HTTP GET /projects/:id/board?sprintId=...
          │
          ▼
    ┌────────────┐
    │IssueCtrl   │
    └──────┬─────┘
           │
           ▼
    ┌────────────┐
    │IssueManager│ → IssueQueryService.getBoardView()
    └──────┬─────┘
           │
           ▼
    ┌─────────────────────────────────┐
    │  redisCache.get(board:<proj>)   │
    └──────────┬──────────────────────┘
               │
        ┌──────┴──────┐
       HIT            MISS
        │              │
        │         ┌────▼───────────────┐
        │         │ MySQL JOIN query   │
        │         │ (issues+assignees) │
        │         └────┬───────────────┘
        │              │
        │         ┌────▼──────────────────────────┐
        │         │ Build BoardView               │
        │         │ groupBy(issues, statusId)     │
        │         └────┬──────────────────────────┘
        │              │
        │         ┌────▼──────────────────────────┐
        │         │ redisCache.set(board, TTL=300) │
        │         │ indexCache.populate() [async]  │
        │         └────┬──────────────────────────┘
        │              │
        └──────┬────────┘
               │
     HTTP 200 { data: BoardView }
```

**Optimistic locking race condition:**

```
Time  Alice (v=1)              Bob (v=1)              DB (version col)
────  ──────────────────────   ──────────────────     ──────────────────
T0    GET /issues/42 → v=1     GET /issues/42 → v=1   version=1
T1    [editing form]           [editing form]          version=1
T2    PATCH {title, version=1}                         UPDATE version→2 ✓
T3                             PATCH {desc, version=1} WHERE version=1 → 0 rows
                                                       → OptimisticLockVersionMismatch
T4                             ← HTTP 409             { currentVersion: 2 }
T5                             GET /issues/42 → v=2
T6                             PATCH {desc, version=2}  UPDATE version→3 ✓
```

No data loss. Alice's title change at T2 is preserved because Bob's T3 write was rejected.

---

## Key Takeaways

- **CQRS separates the service that mutates state from the service that reads it**, enabling each side to be optimised independently — aggressive caching on the read side, strict locking on the write side.
- **CQS is the underlying principle**: a function should either change state or return data, never both. CQRS applies this at the architectural (service) level.
- **Optimistic locking with `@VersionColumn` prevents lost updates** by requiring the client to assert the version it last read. A version mismatch surfaces as HTTP 409, not silent data loss. The `IssueCommandService.update()` method catches `OptimisticLockVersionMismatchError` by name and includes the current server version in the error response.
- **`IssueManager` is the façade that hides the CQRS split** from `IssueController`. It is the single construction and orchestration point for both services, and it owns all cache maintenance logic after writes. This keeps `IssueCommandService` free of Redis concerns.
- **Issue keys are generated atomically using MySQL's `ON DUPLICATE KEY UPDATE` with `LAST_INSERT_ID(expr)`**, which is a single indivisible operation. `SELECT MAX()` + `INSERT` is not safe under concurrency because two threads can observe the same maximum between the two statements.
- **The read path uses a two-level cache**: a sprint/status sorted-set index (`IssueIndexCache`) that stores only IDs, and an entity cache (`IssueEntityCache`) that stores full `Issue` JSON. Partial cache misses result in a single `WHERE id IN (...)` query for only the missing IDs, merged back into the original sorted-set order.
- **`IssueCommandService.transition()` returns `fromStatusId` alongside the updated issue** to enable precise sorted-set surgery (`ZREM` + `ZADD`) in the manager layer, avoiding a full index rebuild on every status transition.
- **Cache failures must not fail writes.** `Promise.allSettled()` (not `Promise.all()`) is used for all post-write cache operations so a Redis outage does not roll back a successful DB write.

---

## Further Reading

- **"Domain-Driven Design" by Eric Evans (2003)** — The foundational book that introduced the aggregate, event, and bounded-context concepts that CQRS builds on. Chapters 5-6 cover entities, value objects, and the repository pattern that `IssueRepository` follows.
- **Greg Young, "CQRS Documents" (2010)** — The original essays where Greg Young formalised CQRS as a named architectural pattern. Available at https://cqrs.files.wordpress.com/2010/11/cqrs_documents.pdf
- **Martin Fowler, "CQRS" (martinfowler.com/bliki/CQRS.html)** — A concise, balanced overview of when CQRS is and is not appropriate. Fowler's cautionary notes about complexity are worth reading before applying the pattern to a new module.
- **"Designing Data-Intensive Applications" by Martin Kleppmann (2017), Chapter 11** — Covers event-driven architectures, stream processing, and the relationship between event logs and read-model projections. The `IssueCreated` / `IssueTransitioned` events in this codebase are the foundation for exactly the patterns Kleppmann describes.
- **MySQL Reference Manual — `INSERT ... ON DUPLICATE KEY UPDATE`** (https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html) — The authoritative description of the atomic upsert pattern used by `IssueKeyGenerator`, including the `LAST_INSERT_ID(expr)` behaviour that makes the counter safe under concurrent connections.
