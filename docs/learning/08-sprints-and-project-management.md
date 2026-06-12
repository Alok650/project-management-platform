# Sprints & Project Management

## What You'll Learn

- What Agile and Scrum are, the problems they were invented to solve, and why timed iterations matter
- What a sprint is, the ceremonies that surround it, and the relationship between a product backlog and a sprint backlog
- What happens to unfinished work when a sprint is closed
- What a project key is (`PROJ`), why issue references (`PROJ-42`) are human-readable identifiers, and the regex that enforces the key format
- What a project member is and why permissions are scoped to a project rather than globally across the platform
- How `SprintService` enforces the one-active-sprint-per-project rule using MySQL advisory locks
- How sprint completion computes velocity, handles carry-over issues, and transitions state
- How `ProjectService` creates projects, manages membership, and keeps RBAC caches in sync
- Why `SprintManager` and `ProjectManager` exist as an orchestration layer above the services
- The specific Joi schema decisions made for dates and project keys

---

## Part 1 — Theory

### 1.1 What Is Agile? What Problem Did It Solve?

Before Agile, the dominant software development model was **Waterfall**: gather all requirements upfront, produce a 200-page specification document, design the entire system, implement everything, then test it at the end. Delivery happened months or years after development started.

The problems this caused were predictable:

- Requirements changed while developers were still writing code. The finished software solved yesterday's problem.
- The first time real users touched the product was at the end, after all the money had been spent.
- Risk accumulated silently. A bad architectural decision made in week 2 wasn't discovered until month 11.

In 2001, seventeen practitioners published the **Agile Manifesto**. Its core insight was simple: *deliver working software frequently* and *respond to change over following a plan*. Instead of one big delivery at the end, deliver small, usable increments every two weeks. Get feedback. Adjust.

Agile is a philosophy, not a process. **Scrum** is the most widely adopted *framework* that operationalises that philosophy.

---

### 1.2 What Is Scrum?

Scrum structures work into three artefacts and four ceremonies.

**Artefacts:**

1. **Product Backlog** — the master ordered list of every feature, bug, and improvement that might ever go into the product. Think of it as a prioritised wish list. Nothing is scheduled yet; items are just candidates for future work.

2. **Sprint Backlog** — the subset of product backlog items that the team has committed to completing in the current sprint. Once the sprint starts, this list is frozen. The team does not pull new scope in from the product backlog mid-sprint.

3. **Increment** — the sum of all product backlog items completed during a sprint. It must be usable and potentially releasable.

**Ceremonies:**

1. **Sprint Planning** — the team selects items from the product backlog, estimates them (often in story points), and moves them into the sprint backlog. The team also defines a sprint goal: a single sentence describing the value this sprint delivers.

2. **Daily Standup (Daily Scrum)** — a 15-minute synchronisation meeting. Each person answers: what did I do yesterday, what will I do today, is anything blocking me? This is not a status report to management; it is the team coordinating with itself.

3. **Sprint Review** — held at the end of the sprint. The team demonstrates the increment to stakeholders. Feedback is gathered. The product backlog may be adjusted.

4. **Sprint Retrospective** — the team reflects on *how it worked*, not *what it built*. What went well? What should change? One or two concrete improvements are committed to for the next sprint.

---

### 1.3 What Is a Sprint?

A sprint is a **time-boxed iteration** — a fixed-length window (typically one or two weeks) during which the team builds and delivers a usable increment. The fixed length is not arbitrary. It creates a heartbeat:

- The deadline is always known and near, so planning stays realistic.
- Feedback loops are short; bad decisions surface quickly.
- Progress is measurable: at the end of every sprint you can see what was and was not delivered.

Think of it like a ship's navigation using dead reckoning before GPS: you don't know exactly where you'll end up at sea, but you fix your position every 24 hours and adjust course. Without those regular fixes, small errors compound into large misses.

In database terms, a sprint in this codebase is a row in the `sprints` table with a `status` column that progresses through three values:

```
PLANNING → ACTIVE → COMPLETED
```

---

### 1.4 Product Backlog vs Sprint Backlog

Here is the key conceptual difference:

```
Product Backlog                    Sprint Backlog
─────────────────────────────      ──────────────────────────────
All issues, any status             Issues assigned to this sprint
Can be reordered any time          Frozen once sprint starts
No time boundary                   Bounded by sprint start/end dates
Owned by the Product Owner         Owned by the development team
Issues have sprintId = NULL        Issues have sprintId = <this sprint>
```

In this codebase, the `Issue` model carries a nullable `sprintId` column (line 53 of `Issue.ts`):

```typescript
@Column({ type: 'varchar', name: 'sprint_id', nullable: true })
sprintId!: string | null;
```

- `sprintId = null` means the issue is in the **product backlog** (unscheduled).
- `sprintId = <uuid>` means the issue belongs to a specific sprint.

There is no separate `sprint_backlog` table. The sprint backlog is simply the set of issues where `sprintId` points to the active sprint.

---

### 1.5 What Happens to Incomplete Issues When a Sprint Is Completed?

This is one of the most important business rules in sprint management.

When a sprint is closed, issues in that sprint fall into two categories:

1. **Done issues** — their workflow status category is `DONE`. These stay attached to the completed sprint. They contributed to the sprint's velocity (story points delivered).

2. **Incomplete issues** — their status is anything other than `DONE` (In Progress, In Review, To Do). They need to go somewhere.

Scrum gives teams a choice for each incomplete issue:

- Move it back to the **product backlog** (set `sprintId = null`). The product owner can reprioritise it.
- Move it to the **next sprint** (set `sprintId = nextSprintId`). This is called "carry-over."

In this codebase the caller explicitly tells the API which incomplete issues to carry over and where:

```typescript
// POST /api/v1/sprints/:sprintId/complete
{
  "carryOverIssueIds": ["uuid-1", "uuid-2"],
  "nextSprintId": "uuid-of-next-sprint"   // optional
}
```

Any incomplete issue whose ID is **not** in `carryOverIssueIds` is returned to the backlog (`sprintId = null`). Any issue whose ID **is** in `carryOverIssueIds` gets `sprintId = nextSprintId` (or `null` if no next sprint was provided, meaning it goes to the backlog even though it was nominated for carry-over — the caller opted it in but didn't specify a destination).

---

### 1.6 What Is a Project Key?

A **project key** is a short, uppercase, alphanumeric identifier that a team chooses when creating a project — for example `PROJ`, `BACKEND`, `MOB2`. It serves as a human-readable namespace for issue references.

Without a project key, issues are referenced by UUID: `3f7a1b2e-4c5d-...`. That is unambiguous but useless in conversation. With a project key, the same issue becomes `PROJ-42`. Engineers can say "fix PROJ-42 before the release" in Slack, in commit messages, in pull request titles, and in documentation. Everyone immediately understands which project and which issue.

The key is stored in the `projects` table with a `UNIQUE` constraint (line 20 of `Project.ts`):

```typescript
/** Short uppercase identifier used to prefix issue keys, e.g. "PROJ" */
@Column({ length: 10, unique: true })
key!: string;
```

And issues carry the generated key in `issueKey` (line 24 of `Issue.ts`):

```typescript
/** Project-scoped human-readable key, e.g. PROJ-42 */
@Column({ name: 'issue_key', length: 20 })
@Index({ unique: true })
issueKey!: string;
```

The uniqueness index on `issueKey` means no two issues in the entire platform can have the same key, even across projects. `PROJ-42` always refers to exactly one issue.

---

### 1.7 Project Members and Why Permissions Are Scoped to a Project

Consider two alternatives for permission modelling:

**Global roles (naive approach):**
```
User → Role (ADMIN | DEVELOPER | VIEWER)
```
This is simple to implement but produces incorrect access control. A user who is ADMIN on Project A should not automatically be ADMIN on Project B. A contractor brought in to view Project C should not be able to see Project D at all.

**Project-scoped membership (this codebase's approach):**
```
User × Project → Role (ADMIN | PROJECT_LEAD | MEMBER | VIEWER)
```
Each row in `project_members` says: "User X has role Y in project P." A user who is not a member of a project cannot see it at all. This is called **row-level security** and it is how products like Jira, Linear, and GitHub model organisations.

The `ProjectMember` entity (in `src/models/ProjectMember.ts`) enforces this with a composite unique constraint:

```typescript
@Entity('project_members')
@Unique(['projectId', 'userId'])
export class ProjectMember {
  @Column({ type: 'enum', enum: ProjectRole, default: ProjectRole.MEMBER })
  role!: ProjectRole;
  // ...
}
```

The `@Unique(['projectId', 'userId'])` decorator maps to a database-level unique index. A user can only have one role per project. If you want to promote someone from `MEMBER` to `PROJECT_LEAD`, you update the existing row — you do not insert a second one.

The four available roles, defined in `ProjectRole` enum, are `ADMIN`, `PROJECT_LEAD`, `MEMBER`, and `VIEWER`. RBAC middleware reads this value from the `membershipCache` (a Redis-backed cache) on every request that requires project-level access, without hitting the database on every call.

---

## Part 2 — Implementation Walkthrough

### 2.1 The Sprint Lifecycle State Diagram

```
                  ┌─────────────────────────────────────────┐
                  │                                         │
         POST /sprints (create)                            │
                  │                                         │
                  ▼                                         │
            ┌──────────┐                                   │
            │ PLANNING │  ◄── default on creation           │
            └──────────┘                                   │
                  │                                         │
     POST /sprints/:id/start                               │
     (advisory lock acquired)                              │
     guard: no other ACTIVE sprint                         │
                  │                                         │
                  ▼                                         │
            ┌──────────┐                                   │
            │  ACTIVE  │  ◄── only one per project          │
            └──────────┘                                   │
                  │                                         │
   POST /sprints/:id/complete                              │
   (advisory lock acquired)                                │
   1. compute velocity                                     │
   2. mark sprint COMPLETED                                │
   3. carry-over or backlog incomplete issues              │
                  │                                         │
                  ▼                                         │
          ┌────────────┐                                   │
          │ COMPLETED  │ ──────────────────────────────────┘
          └────────────┘  (terminal — no transitions out)
```

The `SprintStatus` enum (imported from `src/core/types/enums.ts`) provides the three string values used as the MySQL ENUM column:

```typescript
enum SprintStatus {
  PLANNING  = 'PLANNING',
  ACTIVE    = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}
```

Only two transitions are valid:
- `PLANNING → ACTIVE` (via `start`)
- `ACTIVE → COMPLETED` (via `complete`)

Any other transition — trying to start a `COMPLETED` sprint, or completing a `PLANNING` sprint — throws immediately in the service layer before touching the database.

---

### 2.2 SprintRepository — Data Access Layer

**File:** `src/modules/sprints/SprintRepository.ts`

The repository owns all SQL-level concerns. It has five methods:

| Method | What it does |
|---|---|
| `findById(id)` | Single sprint lookup by UUID primary key |
| `findByProject(projectId)` | All sprints for a project, ordered by `createdAt ASC` |
| `save(data)` | TypeORM upsert — inserts on new entity, updates on existing |
| `findActive(projectId)` | Finds the one sprint with `status = 'ACTIVE'` for a project |
| `getIncompleteIssues(sprintId)` | Issues in this sprint whose status category is not `DONE` |
| `getVelocity(sprintId)` | `SUM(story_points)` of `DONE` issues in this sprint |

The `getIncompleteIssues` query is worth examining closely:

```typescript
// src/modules/sprints/SprintRepository.ts  lines 25–31
getIncompleteIssues(sprintId: string): Promise<Issue[]> {
  return AppDataSource.getRepository(Issue)
    .createQueryBuilder('i')
    .innerJoin('i.status', 's')
    .where('i.sprintId = :sprintId AND s.category != :done AND i.deletedAt IS NULL', { sprintId, done: 'DONE' })
    .getMany();
}
```

The join goes through `i.status` (the `WorkflowStatus` relation on Issue) and filters by `s.category`. The `category` field on `WorkflowStatus` is a meta-classification (`TODO`, `IN_PROGRESS`, `DONE`) that sits above the individual customisable status names. This means a team can rename "In Progress" to "In Development" and the completion logic still works correctly, because it is checking the category, not the status name.

The soft-delete guard (`i.deletedAt IS NULL`) ensures deleted issues are never treated as incomplete.

The velocity query:

```typescript
// src/modules/sprints/SprintRepository.ts  lines 37–45
getVelocity(sprintId: string): Promise<number> {
  return AppDataSource.getRepository(Issue)
    .createQueryBuilder('i')
    .select('COALESCE(SUM(i.storyPoints), 0)', 'total')
    .innerJoin('i.status', 's')
    .where('i.sprintId = :sprintId AND s.category = :done AND i.deletedAt IS NULL', { sprintId, done: 'DONE' })
    .getRawOne()
    .then((r: { total: string } | undefined) => Number(r?.total ?? 0));
}
```

`COALESCE(SUM(...), 0)` handles the case where there are no done issues — `SUM` of zero rows returns `NULL` in SQL, which this coalesces to `0`. The `.then(r => Number(r?.total ?? 0))` is a second defence because `getRawOne()` returns the aggregate as a string from the MySQL driver, not a number.

---

### 2.3 SprintService — Business Logic Layer

**File:** `src/modules/sprints/SprintService.ts`

#### `create` — Simplest Method

```typescript
// src/modules/sprints/SprintService.ts  lines 35–42
async create(
  projectId: string,
  data: { name: string; goal?: string; startDate?: string; endDate?: string },
): Promise<Sprint> {
  const sprint = await this.repo.save({ ...data, projectId, status: SprintStatus.PLANNING });
  redisCache.del(CacheKeys.sprintList(projectId)).catch(() => {});
  return sprint;
}
```

The service hard-codes `status: SprintStatus.PLANNING`. The HTTP caller cannot supply a status at creation time — the sprint always begins in PLANNING. After saving, the sprint list cache for this project is invalidated (the `.catch(() => {})` pattern means cache failures are silently swallowed — the real data is still in MySQL).

#### `list` — Read-Through Cache

```typescript
// src/modules/sprints/SprintService.ts  lines 22–29
async list(projectId: string): Promise<Sprint[]> {
  const cached = await redisCache.get<Sprint[]>(CacheKeys.sprintList(projectId));
  if (cached) return cached;

  const sprints = await this.repo.findByProject(projectId);
  redisCache.set(CacheKeys.sprintList(projectId), sprints, CACHE_TTL.SPRINT_LIST_SECONDS).catch(() => {});
  return sprints;
}
```

Cache key: `sprint:list:<projectId>`. On cache miss, fetch from the repository and populate the cache. The TTL is `CACHE_TTL.SPRINT_LIST_SECONDS` (defined in the cache constants). The cache is proactively invalidated on `create`, `start`, and `complete` — so the TTL is a safety net, not the primary expiration mechanism.

#### `start` — The Advisory Lock Pattern

```typescript
// src/modules/sprints/SprintService.ts  lines 52–81
async start(sprintId: string, actorId: string, correlationId: string): Promise<Sprint> {
  const sprint = await AppDataSource.transaction(async (em) => {
    await em.query(`SELECT GET_LOCK(?, ?)`, [`sprint-start-${sprintId}`, SPRINT_CONSTANTS.ADVISORY_LOCK_TIMEOUT_SECONDS]);
    try {
      const found = await this.repo.findById(sprintId);
      if (!found) throw new NotFoundError('Sprint', sprintId);
      if (found.status !== SprintStatus.PLANNING) throw new ConflictError('Sprint is already started or completed');

      const activeExists = await this.repo.findActive(found.projectId);
      if (activeExists) throw new ConflictError('A sprint is already active for this project');

      const startDate = found.startDate ?? new Date().toISOString().slice(0, 10);
      const updated   = await em.save(Sprint, { ...found, status: SprintStatus.ACTIVE, startDate });

      eventBus.publish({ type: 'SprintUpdated', ... });
      return updated;
    } finally {
      await em.query(`SELECT RELEASE_LOCK(?)`, [`sprint-start-${sprintId}`]);
    }
  });
  // ...
}
```

**Why the advisory lock?**

Without it, two simultaneous requests to start the same sprint would both pass the `findActive` check (both see no active sprint) and both proceed to set the sprint to ACTIVE. The result is data corruption — two active sprints when the invariant allows only one.

MySQL's `GET_LOCK(name, timeout)` is a named application-level lock. It is not a row lock; it is a global lock identified by an arbitrary string. The lock name `sprint-start-${sprintId}` is specific to the sprint being started. If two requests race, the second one blocks at `GET_LOCK` until the first completes and calls `RELEASE_LOCK`, then it proceeds — and finds the sprint is already `ACTIVE`, throwing `ConflictError`.

The `ADVISORY_LOCK_TIMEOUT_SECONDS = 10` constant (from `src/modules/sprints/constants.ts`) means if a lock holder crashes or the connection dies, the lock will automatically time out after 10 seconds rather than holding indefinitely.

The `startDate` defaulting logic (`found.startDate ?? new Date().toISOString().slice(0, 10)`) sets the start date to today if the sprint was created without one. This produces a `YYYY-MM-DD` string, matching the MySQL `DATE` column type.

**The one-active-sprint invariant** is enforced at two points:

1. The `findActive` check inside the advisory lock (line 60).
2. The `PLANNING` status guard just before it (line 58) — you cannot start a sprint that is already `ACTIVE` or `COMPLETED`.

These two together mean:
- You cannot start a sprint that is not in `PLANNING`.
- You cannot start any sprint while another is `ACTIVE` in the same project.

#### `complete` — Sprint Completion Flow

```typescript
// src/modules/sprints/SprintService.ts  lines 95–137
async complete(
  sprintId: string,
  carryOverIssueIds: string[],
  nextSprintId: string | undefined,
  actorId: string,
  correlationId: string,
): Promise<{ sprint: Sprint; incompleteCount: number }> {
  const result = await AppDataSource.transaction(async (em) => {
    await em.query(`SELECT GET_LOCK(?, ?)`, [`sprint-complete-${sprintId}`, SPRINT_CONSTANTS.ADVISORY_LOCK_TIMEOUT_SECONDS]);
    try {
      const sprint = await this.repo.findById(sprintId);
      if (!sprint) throw new NotFoundError('Sprint', sprintId);
      if (sprint.status !== SprintStatus.ACTIVE) throw new UnprocessableError('Only ACTIVE sprints can be completed');

      const velocity        = await this.repo.getVelocity(sprintId);
      const completedSprint = await em.save(Sprint, { ...sprint, status: SprintStatus.COMPLETED, velocity });

      const incomplete = await this.repo.getIncompleteIssues(sprintId);
      const carrySet   = new Set(carryOverIssueIds);

      for (const issue of incomplete) {
        await em.getRepository(Issue).update(
          { id: issue.id },
          { sprintId: carrySet.has(issue.id) ? (nextSprintId ?? null) : null },
        );
      }

      eventBus.publish({ type: 'SprintUpdated', ... });
      return { sprint: completedSprint, incompleteCount: incomplete.length };
    } finally {
      await em.query(`SELECT RELEASE_LOCK(?)`, [`sprint-complete-${sprintId}`]);
    }
  });
  // ...
}
```

Step-by-step flow inside the transaction:

```
1. Acquire advisory lock "sprint-complete-<sprintId>"
2. Load sprint — throw NotFoundError if missing
3. Guard: status must be ACTIVE — throw UnprocessableError if not
4. Query: getVelocity(sprintId) → SUM of story_points on DONE issues
5. Save sprint with status=COMPLETED and velocity=<computed value>
6. Query: getIncompleteIssues(sprintId) → all non-DONE issues
7. Build a Set from carryOverIssueIds for O(1) lookup
8. For each incomplete issue:
     if issue.id IN carrySet → sprintId = nextSprintId ?? null
     if issue.id NOT IN carrySet → sprintId = null (back to backlog)
9. Publish SprintUpdated domain event
10. Return { sprint, incompleteCount }
11. Release advisory lock (in finally block)
```

Everything from steps 4 through 9 happens inside a single database transaction. If anything fails (e.g., the issue update on step 8 throws), the entire transaction rolls back. The sprint is not marked completed, velocity is not written, and no issue assignments change.

The `incompleteCount` in the return value lets the UI tell users "3 issues were returned to the backlog."

---

### 2.4 Joi Schema for Sprints — The Date Regex Decision

**File:** `src/modules/sprints/schemas/sprintSchemas.ts`

```typescript
const dateOnly = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional();

export const createSprintSchema = Joi.object({
  name:      Joi.string().min(1).max(200).required(),
  goal:      Joi.string().max(2000).optional(),
  startDate: dateOnly,
  endDate:   dateOnly,
});
```

**Why `Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)` instead of `Joi.date().iso()` or `Joi.string().isoDate()`?**

The `Sprint` model stores dates as a MySQL `DATE` column (line 27 of `Sprint.ts`):

```typescript
@Column({ name: 'start_date', type: 'date', nullable: true })
startDate!: string | null;
```

MySQL's `DATE` type stores `YYYY-MM-DD`. It has no time component and no timezone.

`Joi.date().iso()` parses the string into a JavaScript `Date` object. When TypeORM then serialises that `Date` object back to MySQL, the driver applies the local timezone offset, potentially shifting the date by one day. A user who sends `"2025-03-15"` could end up with `"2025-03-14"` stored in the database if the server timezone is UTC-something.

`Joi.string().isoDate()` accepts full ISO 8601 timestamps like `"2025-03-15T00:00:00.000Z"`. That timestamp carries timezone information, causing the same problem when stored in a timezone-agnostic `DATE` column.

The regex `/^\d{4}-\d{2}-\d{2}$/` accepts exactly `YYYY-MM-DD` strings. No time component, no timezone offset, no JavaScript `Date` object coercion. The value flows through validation, into the service, and into MySQL exactly as typed. The date the user intended is the date stored.

The tradeoff is that the regex does not validate calendar correctness: `"2025-02-31"` would pass regex validation but fail at the MySQL level. For this application the MySQL constraint is the authoritative guard; the regex prevents the more common mistake of sending a full ISO timestamp.

---

### 2.5 SprintManager — The Orchestration Layer

**File:** `src/modules/sprints/SprintManager.ts`

```typescript
export class SprintManager {
  private readonly service: SprintService;

  constructor() {
    this.service = new SprintService(new SprintRepository());
  }

  list(projectId: string)   { return this.service.list(projectId); }
  create(projectId, data)   { return this.service.create(projectId, data); }
  start(sprintId, actorId, correlationId) { return this.service.start(...); }
  complete(sprintId, carryOverIssueIds, nextSprintId, actorId, correlationId) {
    return this.service.complete(...);
  }
}
```

For sprints, `SprintManager` is deliberately thin — it wires the repository into the service and exposes the same interface upward. Its value becomes clearer in the project module where the manager integrates multiple collaborators.

The architectural reason for this layer:

1. **Dependency construction** — The controller should not know that `SprintService` depends on `SprintRepository`. The manager owns that wiring. Controllers depend on managers, not on the service/repository graph.

2. **Extension point** — If sprint operations later need to notify a search indexer, invalidate an additional cache, or call an external webhook service, that coordination logic belongs in the manager — not inside the service (which should stay focused on business rules) and not inside the controller (which should stay focused on HTTP concerns).

3. **Testability** — Controllers can be unit-tested by injecting a mock manager. Services can be unit-tested by injecting a mock repository. The manager can be integration-tested at the boundary between the two.

---

### 2.6 SprintController — HTTP Handler Layer

**File:** `src/modules/sprints/SprintController.ts`

```typescript
export class SprintController {
  static async list(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.list(ctx.params['projectId']!));
  }

  static async create(ctx: Context): Promise<void> {
    const sprint = await manager.create(ctx.params['projectId']!, ctx.request.body as any);
    ctx.status = 201;
    ctx.body = ok(sprint);
  }

  static async start(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.start(ctx.params['sprintId']!, ctx.state.user.id, ctx.state.correlationId));
  }

  static async complete(ctx: Context): Promise<void> {
    const { carryOverIssueIds, nextSprintId } = ctx.request.body as {
      carryOverIssueIds: string[];
      nextSprintId?: string;
    };
    ctx.body = ok(await manager.complete(
      ctx.params['sprintId']!, carryOverIssueIds, nextSprintId,
      ctx.state.user.id, ctx.state.correlationId
    ));
  }
}
```

The controller contains no business logic. Its job is:

1. Extract parameters from `ctx.params`, `ctx.request.body`, and `ctx.state`.
2. Call the manager.
3. Set `ctx.status` (defaults to 200, overridden to 201 on create).
4. Wrap the result in `ok()` (the standard API response envelope) and assign to `ctx.body`.

`ctx.state.user.id` is the authenticated user's ID, populated by JWT middleware earlier in the Koa middleware chain. `ctx.state.correlationId` is a UUID generated per request by a correlation middleware — it flows through to domain events for distributed tracing.

**Route map:**

```
GET  /api/v1/projects/:projectId/sprints      → SprintController.list
POST /api/v1/projects/:projectId/sprints      → SprintController.create
POST /api/v1/sprints/:sprintId/start          → SprintController.start
POST /api/v1/sprints/:sprintId/complete       → SprintController.complete
```

Notice that `start` and `complete` are on `/sprints/:sprintId` rather than `/projects/:projectId/sprints/:sprintId`. This is intentional: once you have a sprint ID, you don't need the project ID in the URL. The sprint record already carries its `projectId`.

---

### 2.7 ProjectRepository — Data Access Layer

**File:** `src/modules/projects/ProjectRepository.ts`

The repository manages two tables: `projects` and `project_members`. It exposes ten methods across the two entities:

```typescript
// Project methods
findById(id)             // PK lookup
findByKey(key)           // unique key lookup (used for uniqueness check)
findAllForUser(userId)   // row-level security: only projects user is a member of
save(project)            // insert or update
softDelete(id)           // sets deleted_at, TypeORM handles the rest

// Member methods
findMembership(projectId, userId)   // single membership row lookup
saveMember(member)                  // insert or update a membership
removeMember(projectId, userId)     // hard-delete a membership row
listMembers(projectId)              // all members with user relation loaded
```

The `findAllForUser` query implements row-level security:

```typescript
// src/modules/projects/ProjectRepository.ts  lines 22–27
findAllForUser(userId: string): Promise<Project[]> {
  return this.projectRepo
    .createQueryBuilder('p')
    .innerJoin('p.members', 'm', 'm.userId = :userId', { userId })
    .orderBy('p.createdAt', 'DESC')
    .getMany();
}
```

The `INNER JOIN` on `project_members` means only projects where the user has a membership row are returned. A project with no membership record for this user is invisible. The join condition `m.userId = :userId` is parameterised — no SQL injection risk.

Note the distinction between `softDelete` (sets `deleted_at`) and `removeMember` (hard-delete). Projects are soft-deleted because their history (issues, sprints, comments) should be preserved for audit purposes. Members are hard-deleted because membership itself carries no historical significance — what matters is the current state of who can access what.

---

### 2.8 ProjectService — Business Logic Layer

**File:** `src/modules/projects/ProjectService.ts`

#### `create` — Key Uniqueness and Auto-membership

```typescript
// src/modules/projects/ProjectService.ts  lines 20–29
async create(data: { name: string; key: string; description?: string; createdById: string }): Promise<Project> {
  const existing = await this.repo.findByKey(data.key);
  if (existing) throw new ConflictError(`Project key '${data.key}' already exists`);

  const project = await this.repo.save(data);
  await this.repo.saveMember({ projectId: project.id, userId: data.createdById, role: ProjectRole.ADMIN });

  redisCache.del(CacheKeys.projectList(data.createdById)).catch(() => {});
  return project;
}
```

Two database writes happen on project creation:
1. Insert the project row.
2. Insert a `project_members` row making the creator an `ADMIN`.

This auto-membership is critical. Without it, the creator would immediately fail the `findAllForUser` query — their project would be invisible to them, and they would not be able to add anyone else.

The `ConflictError` is thrown before attempting the insert. This is an application-level uniqueness check. The database also has a `UNIQUE` constraint on `projects.key` (line 21 of `Project.ts`), so even if two concurrent requests passed this check simultaneously, one would fail at the database level with a constraint violation.

#### `getById` — Membership-gated Read

```typescript
// src/modules/projects/ProjectService.ts  lines 36–42
async getById(id: string, requestingUserId: string): Promise<Project> {
  const project = await this.repo.findById(id);
  if (!project) throw new NotFoundError('Project', id);
  const membership = await this.repo.findMembership(id, requestingUserId);
  if (!membership) throw new ForbiddenError('access', 'this project');
  return project;
}
```

The service intentionally throws `NotFoundError` first (before the membership check) when the project does not exist, and `ForbiddenError` when the project exists but the user is not a member. This is a deliberate security-versus-usability trade-off: revealing that a project exists to a non-member leaks information (an attacker could enumerate project IDs), but in practice most callers are authenticated users following in-app links, and a `403` on a valid project ID is more actionable than a `404`.

#### `addMember` and `updateMemberRole` — Cache Invalidation Differences

```typescript
// addMember: invalidates the new user's project list
async addMember(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
  const existing = await this.repo.findMembership(projectId, userId);
  if (existing) throw new ConflictError('User is already a member of this project');
  const member = await this.repo.saveMember({ projectId, userId, role });
  redisCache.del(CacheKeys.projectList(userId)).catch(() => {});
  return member;
}

// updateMemberRole: invalidates the membership role cache (used by RBAC)
async updateMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
  const member = await this.repo.findMembership(projectId, userId);
  if (!member) throw new NotFoundError('ProjectMember', userId);
  const updated = await this.repo.saveMember({ ...member, role });
  membershipCache.del(projectId, userId).catch(() => {});
  return updated;
}
```

These two methods invalidate different caches:

- **`addMember`** invalidates `CacheKeys.projectList(userId)` — the list of projects visible to that user. After being added, the new project must appear in their list on next fetch.

- **`updateMemberRole`** invalidates `membershipCache` for the specific `(projectId, userId)` pair. The `membershipCache` is what the RBAC middleware consults to check "does this user have ADMIN rights on this project?" If a user is demoted from `ADMIN` to `MEMBER`, that demotion must take effect on the next request, not after the cache TTL expires.

**`removeMember`** invalidates both, because the user's project list must shrink and their RBAC role must become non-existent:

```typescript
async removeMember(projectId: string, userId: string): Promise<void> {
  await this.repo.removeMember(projectId, userId);
  await Promise.allSettled([
    membershipCache.del(projectId, userId),
    redisCache.del(CacheKeys.projectList(userId)),
  ]);
}
```

`Promise.allSettled` is used here instead of `Promise.all` so that a cache deletion failure for one cache does not prevent the other from being deleted.

---

### 2.9 Joi Schema for Projects — The Key Regex

**File:** `src/modules/projects/schemas/projectSchemas.ts`

```typescript
export const createProjectSchema = Joi.object({
  name:        Joi.string().min(2).max(200).required(),
  key:         Joi.string().pattern(/^[A-Z0-9]{2,10}$/).required(),
  description: Joi.string().max(2000).optional(),
});
```

The pattern `/^[A-Z0-9]{2,10}$/` enforces four constraints simultaneously:

1. **Only uppercase letters and digits** — no lowercase, no hyphens, no spaces. This ensures `PROJ-42` issue keys are unambiguous: the hyphen is always the separator between the project key and the issue number.

2. **At least 2 characters** — single-character keys would be too ambiguous and too easily collide.

3. **At most 10 characters** — keeps issue keys readable. `BACKEND-42` is 10 characters; anything longer makes commit message references unwieldy.

4. **No implicit normalisation** — the API does not silently lowercase or uppercase input. If you send `"proj"`, validation fails. The client must send `"PROJ"`. This makes the schema the authoritative rule, and the stored value is exactly what was validated.

The database-level uniqueness on `projects.key` is the final enforcement layer, but Joi catches the format violations before any database round trip.

The `addMemberSchema` validates the role value against the exact string literals of the `ProjectRole` enum:

```typescript
export const addMemberSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  role:   Joi.string().valid('ADMIN','PROJECT_LEAD','MEMBER','VIEWER').required(),
});
```

Enumerating the values explicitly in Joi (rather than using a dynamic `Object.values(ProjectRole)`) means the schema is decoupled from the TypeScript enum at runtime. A typo in the enum value would not silently allow invalid roles through — the Joi schema would still reject anything outside these four strings. The tradeoff is that adding a new role requires updating the Joi schema as well.

---

### 2.10 ProjectManager — The Orchestration Layer

**File:** `src/modules/projects/ProjectManager.ts`

```typescript
export class ProjectManager {
  private readonly service: ProjectService;

  constructor() {
    this.service = new ProjectService(new ProjectRepository());
  }

  create(data: { name: string; key: string; description?: string }, createdById: string) {
    return this.service.create({ ...data, createdById });
  }

  get(id: string, userId: string)                         { return this.service.getById(id, userId); }
  list(userId: string)                                    { return this.service.listForUser(userId); }
  update(id: string, data)                                { return this.service.update(id, data); }
  delete(id: string)                                      { return this.service.delete(id); }
  addMember(projectId, userId, role)                      { return this.service.addMember(projectId, userId, role); }
  updateMemberRole(projectId, userId, role)               { return this.service.updateMemberRole(projectId, userId, role); }
  removeMember(projectId, userId)                         { return this.service.removeMember(projectId, userId); }
  listMembers(projectId)                                  { return this.service.listMembers(projectId); }
}
```

The `create` method is the only one that does non-trivial argument transformation. The controller receives `{ name, key, description }` from the request body and `createdById` from the authenticated session separately. The manager merges them into the shape the service expects: `{ name, key, description, createdById }`. This prevents `createdById` from ever being a field in the request body — the creator is always derived from the authenticated session, never from user-supplied data.

---

### 2.11 Full Request Data Flow — Starting a Sprint

Here is the complete path for `POST /api/v1/sprints/:sprintId/start`:

```
HTTP Request (with JWT Bearer token)
        │
        ▼
Koa Middleware Stack
  ├── correlationId middleware  → attaches ctx.state.correlationId
  ├── JWT middleware            → attaches ctx.state.user
  ├── RBAC middleware           → checks membershipCache for PROJECT_LEAD+ role
  └── Joi validation middleware → validates request body (no body needed for start)
        │
        ▼
SprintController.start(ctx)
  Extracts: sprintId, actorId, correlationId from ctx
        │
        ▼
SprintManager.start(sprintId, actorId, correlationId)
  Delegates directly to SprintService
        │
        ▼
SprintService.start(sprintId, actorId, correlationId)
  1. Opens MySQL transaction
  2. GET_LOCK("sprint-start-<sprintId>", 10)
  3. repo.findById(sprintId)
       └── throws NotFoundError if missing
  4. Guard: status === PLANNING
       └── throws ConflictError if not
  5. repo.findActive(projectId)
       └── throws ConflictError if active sprint exists
  6. em.save(Sprint, { status: ACTIVE, startDate: today })
  7. eventBus.publish(SprintUpdatedEvent)
  8. RELEASE_LOCK
  9. redisCache.del(sprintList:<projectId>)
        │
        ▼
SprintController
  ctx.body = ok(updatedSprint)
        │
        ▼
HTTP Response 200: { success: true, data: { id, name, status: "ACTIVE", ... } }
```

---

## Key Takeaways

- Agile solves the feedback delay problem of Waterfall by delivering working software in short, fixed-length iterations (sprints) rather than one large batch at the end.
- A sprint has three states — `PLANNING`, `ACTIVE`, `COMPLETED` — and the transitions are one-directional and irreversible. There is no "reopen sprint" operation.
- The one-active-sprint-per-project invariant is enforced with a MySQL advisory lock (`GET_LOCK`/`RELEASE_LOCK`) inside a transaction. This prevents the race condition that would arise from a simple read-then-write check-then-act pattern.
- Incomplete issues at sprint completion are either moved to a named next sprint (`sprintId = nextSprintId`) or returned to the product backlog (`sprintId = null`). Done issues stay attached to the completed sprint and their story points are summed into the sprint's `velocity` column.
- Project keys (`/^[A-Z0-9]{2,10}$/`) must be uppercase-only so that the separator convention (`PROJ-42`) is unambiguous at a glance. Joi validates format; a database `UNIQUE` constraint enforces global uniqueness.
- Project membership (`project_members` table) provides row-level security: `findAllForUser` uses an `INNER JOIN` so only projects where a membership row exists are returned. Non-members cannot see the project at all.
- Cache invalidation is targeted, not blanket. `addMember` invalidates the user's project list. `updateMemberRole` invalidates the RBAC membership cache. `removeMember` invalidates both. This keeps RBAC changes taking effect immediately without a cache TTL delay.
- The Manager layer (SprintManager, ProjectManager) decouples controllers from the service/repository graph, owns dependency wiring, and is the correct place to add cross-cutting coordination (additional caches, event publishing, external calls) without polluting business logic or HTTP handling code.
- Date fields in Joi use a plain string regex (`/^\d{4}-\d{2}-\d{2}$/`) rather than `Joi.date().iso()` to avoid JavaScript `Date` object timezone coercion corrupting values stored in MySQL `DATE` (date-only) columns.

---

## Further Reading

- **"Scrum: The Art of Doing Twice the Work in Half the Time"** — Jeff Sutherland (Crown Business, 2014). Written by one of Scrum's co-creators. Explains the original motivations and the empirical experiments behind the framework.
- **"The Agile Manifesto"** — Beck et al., 2001. [agilemanifesto.org](https://agilemanifesto.org). The original four values and twelve principles. Short enough to read in five minutes; dense enough to re-read every year.
- **"Accelerate: The Science of Lean Software and DevOps"** — Forsgren, Humble, Kim (IT Revolution Press, 2018). Research-backed evidence for why short iteration cycles, trunk-based development, and continuous delivery produce better outcomes. Provides the "why" behind Agile's emphasis on delivery frequency.
- **MySQL 8.0 Reference Manual — Locking Functions** — [dev.mysql.com/doc/refman/8.0/en/locking-functions.html](https://dev.mysql.com/doc/refman/8.0/en/locking-functions.html). Authoritative documentation for `GET_LOCK`, `RELEASE_LOCK`, and their transactional semantics. Essential reading before using advisory locks in production.
- **"Domain-Driven Design: Tackling Complexity in the Heart of Software"** — Eric Evans (Addison-Wesley, 2003). The canonical reference for why a domain model should own business rules (SprintService enforcing state transitions) rather than embedding them in database triggers or HTTP handlers.
