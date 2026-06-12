# Workflow Engine

## What You'll Learn

- What a Finite State Machine (FSM) is and how it maps directly onto issue status workflows
- The Strategy pattern and why the codebase uses it for validation hooks instead of hardcoded `if` chains
- What WIP limits are, where they come from (Kanban), and why enforcing them improves team throughput
- What Auto Actions are and how they automate side effects after a transition without polluting the core transition logic
- The three database models that form the workflow data layer: `WorkflowStatus`, `WorkflowTransition`, and `WorkflowAutoAction`
- Step-by-step data flow through `WorkflowEngine.transition()`, from permission check to event publication
- How `ValidationHookRunner` implements a Chain of Responsibility to sequence guards
- How to add a new validation hook in fewer than twenty lines of code

---

## Part 1: Theory

### Finite State Machines

A Finite State Machine (FSM) is a mathematical model of computation that describes a system which can be in exactly one of a finite number of **states** at any given time. The machine moves from one state to another by consuming an **input** that triggers a **transition**. Each transition may have a **guard** — a condition that must be true before the transition is allowed to fire.

The formal definition has five parts:

1. **S** — a finite set of states
2. **Σ** — a finite set of inputs (the alphabet)
3. **δ** — a transition function: `δ(current_state, input) → next_state`
4. **s₀** — the initial state
5. **F** — a set of accepting (terminal) states

**Traffic Light Example**

A traffic light is the simplest real-world FSM:

```
States:   { RED, GREEN, YELLOW }
Alphabet: { TIMER_EXPIRES }
Transitions:
  δ(RED,    TIMER_EXPIRES) → GREEN
  δ(GREEN,  TIMER_EXPIRES) → YELLOW
  δ(YELLOW, TIMER_EXPIRES) → RED
Initial state: RED
```

There is no transition `δ(RED, TIMER_EXPIRES) → YELLOW` — that move is simply not in the transition table. If you tried to trigger it, the machine would reject it.

**Mapping to Issue Workflows**

An issue workflow is an FSM where:

| FSM concept    | Workflow concept                          |
|----------------|-------------------------------------------|
| State          | `WorkflowStatus` row (Backlog, In Progress, In Review, Done) |
| Input          | A developer calling `POST /issues/:id/transition` |
| Transition     | `WorkflowTransition` row (fromStatusId → toStatusId) |
| Guard          | Validation hook (`WipLimitHook`, `RequiredFieldHook`) |
| Terminal state | Any status with `category = DONE`         |

If a team tries to move an issue from "Backlog" directly to "Done" but that `WorkflowTransition` row does not exist, the engine rejects the move, exactly as the traffic light rejects RED → YELLOW.

```
ASCII State Diagram — Typical Issue Workflow

  ┌─────────┐   "Start work"   ┌─────────────┐   "Submit for review"   ┌───────────┐
  │ Backlog │ ───────────────► │ In Progress │ ───────────────────────► │ In Review │
  └─────────┘                  └─────────────┘                          └───────────┘
                                      ▲                                       │
                                      │    "Request changes"                  │ "Approve"
                                      └───────────────────────────────────────┘
                                                                               │
                                                                               ▼
                                                                           ┌──────┐
                                                                           │ Done │
                                                                           └──────┘
```

Each arrow is a row in `workflow_transitions`. There is deliberately no arrow from Backlog directly to Done — that transition row simply does not exist, so the engine refuses it.

---

### The Strategy Pattern

The Strategy pattern is a behavioural design pattern where a family of algorithms is defined, each is encapsulated in its own class, and they are made interchangeable. The caller (the **context**) holds a reference to the strategy interface rather than any concrete implementation.

**Why it matters:** without the Strategy pattern you end up writing this kind of code, which violates the Open/Closed Principle:

```typescript
// Anti-pattern: monolithic validation inside the transition logic
async function transition(issue, toStatusId) {
  // Hard-coded guard 1
  if (toStatus.wipLimit && count >= toStatus.wipLimit) {
    throw new Error('WIP limit reached');
  }
  // Hard-coded guard 2
  if (toStatus.category === 'DONE' && issue.storyPoints == null) {
    throw new Error('Story points required');
  }
  // Hard-coded guard 3 (future)
  if (someOtherCondition) { ... }
  // ... the function grows without bound
}
```

With the Strategy pattern, adding a new guard requires creating one new class and passing it to the runner — the runner and engine are not touched:

```
Interface: IValidationHook
  └── validate(ctx: TransitionContext): Promise<string | null>

Implementations:
  WipLimitHook       implements IValidationHook
  RequiredFieldHook  implements IValidationHook
  (future)  SprintCapacityHook  implements IValidationHook

Context (uses the strategy):
  ValidationHookRunner
    - holds: ReadonlyArray<IValidationHook>
    - calls: hook.validate(ctx) for each hook
```

The `ValidationHookRunner` is the **context**. It does not know what any hook does — it only knows the contract defined by `IValidationHook`. This is also a Chain of Responsibility: each hook in the array is tried in sequence; the first non-null return value short-circuits the chain.

---

### Validation Hooks as Guards

In classical FSM theory a guard is a Boolean predicate attached to a transition edge. In code, a guard is typically a function that receives context and returns true/false. This codebase elevates that concept to a richer form: hooks return `null` (pass) or a human-readable error string (fail), so the error message is produced by the hook closest to the rule that was violated rather than being assembled later.

**Why hooks are better than hardcoding validation inside the transition method:**

1. **Single Responsibility.** Each hook owns exactly one rule. `WipLimitHook` knows about WIP; `RequiredFieldHook` knows about required fields. Neither knows the other exists.
2. **Open/Closed.** The `WorkflowEngine` is closed for modification. Adding a new business rule means adding a new file, not editing existing code.
3. **Testability.** Each hook can be unit-tested in complete isolation by passing a mock `TransitionContext` — no database, no engine, no other hooks needed.
4. **Ordering control.** The hook runner runs hooks in the order they are passed to its constructor. Cheap synchronous checks (like `RequiredFieldHook`) could be placed before expensive DB checks (like `WipLimitHook`) to fail fast.

---

### WIP Limits and Kanban

WIP stands for **Work In Progress**. The concept originates from the Toyota Production System and was adapted into software development by David J. Anderson's Kanban method (published in the book *Kanban: Successful Evolutionary Change for Your Technology Business*, 2010).

The core principle is Little's Law from queueing theory:

```
Lead Time = Work In Progress / Throughput
```

If throughput (rate of completing work) is constant, then the only way to reduce lead time is to reduce WIP. Kanban teams draw a board where each column (status) has a number posted at the top — the WIP limit. A developer is not allowed to pull a new card into that column if it is already at its limit.

**Why WIP limits improve throughput in practice:**

- They force teams to finish work before starting new work, reducing context switching.
- They surface bottlenecks immediately: if "In Review" is always at its limit, it signals that the team needs more review capacity.
- They prevent the "I'm blocked, so I'll start something new" spiral that makes lead times balloon.

In this codebase a WIP limit is stored as an integer on the `WorkflowStatus` row (`wip_limit` column, nullable). `null` means unlimited. The `WipLimitHook` enforces it at transition time by counting issues currently in the target status before allowing the move.

---

### Auto Actions

An Auto Action is a side effect that fires automatically after a workflow transition succeeds. It is the workflow equivalent of a database trigger — but implemented in application code so it is testable and observable.

**Real-world problems Auto Actions solve:**

- **Automatic assignment.** When a developer moves an issue to "In Review", the system automatically sets the current user as the reviewer, eliminating the manual step of going back to the issue and changing the assignee field.
- **Field population.** When an issue moves to "Done", the system can automatically stamp a `completedAt` timestamp, removing the need for a separate API call.
- **Notifications.** When an issue moves to "Blocked", the system can notify the project lead automatically.
- **Integration hooks.** Moving to "Deployed" could trigger a Jira sync or a Slack message without the developer doing anything extra.

Auto Actions are "best-effort" in this codebase: their failures are logged but do not roll back the transition. This is the right trade-off — a failed Slack notification should not undo a legitimate status change.

---

## Part 2: Implementation Walkthrough

### The Three Database Models

#### `WorkflowStatus` — Nodes of the Graph

`src/models/WorkflowStatus.ts`

```typescript
@Entity('workflow_statuses')
export class WorkflowStatus {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ type: 'enum', enum: StatusCategory, default: StatusCategory.TODO })
  category!: StatusCategory;

  /** Display order on the board (ascending) */
  @Column({ type: 'int', default: 0 })
  position!: number;

  /** Maximum number of issues allowed in this status; null = unlimited */
  @Column({ name: 'wip_limit', type: 'int', nullable: true })
  wipLimit!: number | null;
}
```

Key points:

- `category` is an enum (`TODO | IN_PROGRESS | DONE`). The `RequiredFieldHook` uses this to decide whether a transition targets a "done" column without needing to know the status name.
- `position` controls the left-to-right order on the Kanban board; it is purely presentational and does not affect FSM logic.
- `wipLimit` is `null` by default, meaning the column accepts unlimited issues. Setting it to `3` means the `WipLimitHook` will block any issue from entering once three issues are already there.

Each `WorkflowStatus` row is a **node** in the directed graph that represents the workflow.

#### `WorkflowTransition` — Edges of the Graph

`src/models/WorkflowTransition.ts`

```typescript
@Entity('workflow_transitions')
export class WorkflowTransition {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'from_status_id' })
  fromStatusId!: string;

  @Column({ name: 'to_status_id' })
  toStatusId!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name!: string | null;

  @ManyToOne('WorkflowStatus')
  @JoinColumn({ name: 'from_status_id' })
  fromStatus!: WorkflowStatus;

  @ManyToOne('WorkflowStatus')
  @JoinColumn({ name: 'to_status_id' })
  toStatus!: WorkflowStatus;

  @OneToMany('WorkflowAutoAction', 'transition')
  autoActions!: WorkflowAutoAction[];
}
```

Each row is a **directed edge** from one `WorkflowStatus` node to another. The `name` field is optional human-readable label for the transition (e.g. "Start work", "Submit for review"). The `autoActions` relation means that each edge can carry a set of side effects that fire when the edge is traversed.

The absence of a row for a (fromStatusId, toStatusId) pair is itself significant — it means the transition is forbidden. There is no "deny" flag; non-existence is the denial.

#### `WorkflowAutoAction` — Side Effects on Edges

`src/models/WorkflowAutoAction.ts`

```typescript
@Entity('workflow_auto_actions')
export class WorkflowAutoAction {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'transition_id' })
  transitionId!: string;

  @Column({ type: 'enum', enum: AutoActionType })
  type!: AutoActionType;

  /**
   * JSON configuration for the action.
   * Example: { "assignTo": "current_user" } for ASSIGN_REVIEWER
   */
  @Column({ type: 'json' })
  config!: Record<string, unknown>;
}
```

The `config` column stores a JSON blob whose shape depends on `type`. For `ASSIGN_REVIEWER`, the config is `{ "assignTo": "current_user" | "<userId>" }`. This schema-less approach gives flexibility — a `SET_FIELD` action would have `{ "field": "priority", "value": "HIGH" }` as its config without requiring a schema migration.

---

### WorkflowRepository — Data Access Layer

`src/modules/workflow/WorkflowRepository.ts`

The repository has two important query methods worth examining:

```typescript
/** Load transition with toStatus relation (for WIP limit) and autoActions */
findTransition(fromStatusId: string, toStatusId: string): Promise<WorkflowTransition | null> {
  return this.transitionRepo.findOne({
    where: { fromStatusId, toStatusId },
    relations: ['toStatus', 'autoActions'],
  });
}
```

This single query loads the transition row **and** eagerly joins the `toStatus` object (needed by `WipLimitHook` and `RequiredFieldHook` to read `wipLimit` and `category` without a second round-trip) and the `autoActions` collection (needed by `AutoActionExecutor`). Loading all three in one query is a deliberate performance choice.

```typescript
/** Find all allowed transitions from a given status, including toStatus relation */
findAllowedTransitions(fromStatusId: string): Promise<WorkflowTransition[]> {
  return this.transitionRepo.find({
    where: { fromStatusId },
    relations: ['toStatus'],
  });
}
```

This is used only in the error path — when a transition is not found, the engine loads all legal next states so the error payload can tell the caller exactly which transitions are available.

---

### WorkflowEngine — The Orchestrator

`src/modules/workflow/WorkflowEngine.ts`

The engine is the central coordinator. It is constructed once per request (or could be a singleton) and owns references to the three collaborators:

```typescript
export class WorkflowEngine {
  private readonly workflowRepo   = new WorkflowRepository();
  private readonly hookRunner     = new ValidationHookRunner([new WipLimitHook(), new RequiredFieldHook()]);
  private readonly actionExecutor = new AutoActionExecutor();
```

Note the hook order: `WipLimitHook` runs before `RequiredFieldHook`. This is intentional — if a column is full, there is no point telling the user they also need to add story points; the column-full error is more immediately actionable.

The full transition flow in `WorkflowEngine.transition()`:

```typescript
async transition(issue: Issue, toStatusId: string, actorId: string, correlationId: string): Promise<Issue> {
  // Step 1: FSM guard — is this edge in the transition table?
  const transition = await this.workflowRepo.findTransition(issue.statusId, toStatusId);
  if (!transition) {
    const allowed = await this.workflowRepo.findAllowedTransitions(issue.statusId);
    throw new UnprocessableError(
      `Transition from current status to '${toStatusId}' is not allowed`,
      allowed.map((t) => t.toStatusId),
    );
  }

  // Step 2: Run all validation hooks (Chain of Responsibility)
  await this.hookRunner.run({ issue, transition, actorId, correlationId });

  // Step 3: Persist the new statusId inside a transaction
  const fromStatusId = issue.statusId;
  const updated = await AppDataSource.transaction(async (em) => {
    await em.update(Issue, { id: issue.id }, { statusId: toStatusId });
    return em.findOneOrFail(Issue, { where: { id: issue.id } });
  });

  // Step 4: Execute auto-actions (best-effort, outside the transaction)
  if (transition.autoActions?.length) {
    await this.actionExecutor.execute(transition.autoActions, updated, actorId);
  }

  // Step 5: Publish domain event
  const event: StatusChangedEvent = {
    type: 'StatusChanged',
    occurredAt: new Date(),
    correlationId,
    payload: { issueId: issue.id, projectId: issue.projectId, fromStatusId, toStatusId, actorId },
  };
  eventBus.publish(event);

  return updated;
}
```

**What happens when a transition is attempted that is not in the table:**

Step 1 returns `null` from `findTransition`. The engine then calls `findAllowedTransitions` to get the full list of legal next states and throws `UnprocessableError` with the message and the array of valid `toStatusId` values in the error payload. The HTTP layer should return a `422 Unprocessable Entity` response with a body like:

```json
{
  "error": "Transition from current status to 'uuid-of-done' is not allowed",
  "allowedTransitions": ["uuid-of-in-progress", "uuid-of-blocked"]
}
```

The client can use this list to render only the legal transition buttons in the UI.

**ASCII data-flow diagram:**

```
  POST /issues/:id/transition { toStatusId }
          │
          ▼
  WorkflowEngine.transition()
          │
          ├─► findTransition(fromStatusId, toStatusId)
          │         │
          │         ├── NOT FOUND → findAllowedTransitions() → throw UnprocessableError(422)
          │         │
          │         └── FOUND → WorkflowTransition (with toStatus + autoActions loaded)
          │
          ├─► hookRunner.run(ctx)
          │         │
          │         ├── WipLimitHook.validate(ctx)  → error? → throw UnprocessableError(422)
          │         │
          │         └── RequiredFieldHook.validate(ctx) → error? → throw UnprocessableError(422)
          │
          ├─► DB transaction: UPDATE issues SET status_id = toStatusId
          │                   SELECT * FROM issues WHERE id = issue.id
          │
          ├─► AutoActionExecutor.execute(autoActions, updatedIssue, actorId)  [best-effort]
          │
          └─► eventBus.publish(StatusChangedEvent)
                    │
                    └── async subscribers (notifications, search index, audit log, ...)
```

---

### ValidationHookRunner — Chain of Responsibility

`src/modules/workflow/ValidationHookRunner.ts`

```typescript
export class ValidationHookRunner {
  private readonly hooks: ReadonlyArray<IValidationHook>;

  constructor(hooks: IValidationHook[]) {
    this.hooks = hooks;
  }

  async run(ctx: TransitionContext): Promise<void> {
    for (const hook of this.hooks) {
      const error = await hook.validate(ctx);
      if (error) throw new UnprocessableError(error);
    }
  }
}
```

Three design decisions worth noting:

1. **`ReadonlyArray`** — the hook list cannot be mutated after construction, preventing accidental runtime modification of registered hooks.
2. **`for...of` not `Promise.all`** — hooks run sequentially, not in parallel. This is deliberate: if `WipLimitHook` fails, there is no point running `RequiredFieldHook`. Running them in parallel would fire unnecessary DB queries and produce multiple error messages when only one is shown to the user.
3. **Single error at a time** — the runner throws on the first failure. This is standard validation UX: fix the most important problem first, re-submit, then see the next one if any remains. Bulk validation (showing all errors at once) would require a different runner that collects errors instead of throwing.

---

### WipLimitHook — Deep Dive

`src/modules/workflow/hooks/WipLimitHook.ts`

```typescript
export class WipLimitHook implements IValidationHook {
  async validate(ctx: TransitionContext): Promise<string | null> {
    const toStatus = ctx.transition.toStatus;
    if (!toStatus?.wipLimit) return null;          // (1) fast exit if no limit configured

    const currentCount = await AppDataSource.getRepository(Issue).count({
      where: { projectId: ctx.issue.projectId, statusId: toStatus.id },
    });                                             // (2) count issues in target status

    if (currentCount >= toStatus.wipLimit) {
      return `WIP limit of ${toStatus.wipLimit} reached for status '${toStatus.name}'`;
    }
    return null;
  }
}
```

Step-by-step:

1. **Short-circuit on null limit.** If `toStatus.wipLimit` is `null` or `0` (falsy), no limit is configured for this status and the hook immediately returns `null` (pass). This avoids the DB query entirely for statuses without a WIP constraint.
2. **Count current occupants.** The query counts issues that are in the same project and already have `statusId = toStatus.id`. It is scoped to `projectId` — WIP limits are per-project per-column, not global.
3. **Threshold check.** `>=` rather than `>` means the limit is the maximum number of issues the column can hold. A `wipLimit` of `3` allows three issues; the fourth is rejected.
4. **Human-readable error.** The message includes both the numeric limit and the status name so the error in the API response is immediately actionable without a client having to look up what status ID `xyz-uuid` refers to.

**Concurrency note:** There is a subtle TOCTOU (time-of-check-time-of-use) race condition here. If two developers submit transitions simultaneously, both might read `currentCount = 2` against a `wipLimit = 3`, both pass the check, and the column ends up with 4 issues. Solving this correctly requires either a `SELECT ... FOR UPDATE` advisory lock on the status row or a database trigger. For most teams this edge case is acceptable; documenting it here so future contributors are aware.

---

### RequiredFieldHook — Deep Dive

`src/modules/workflow/hooks/RequiredFieldHook.ts`

```typescript
export class RequiredFieldHook implements IValidationHook {
  async validate(ctx: TransitionContext): Promise<string | null> {
    const { issue, transition } = ctx;
    if (
      transition.toStatus?.category === StatusCategory.DONE &&
      (issue.type === IssueType.STORY || issue.type === IssueType.EPIC) &&
      issue.storyPoints == null
    ) {
      return 'Story points are required before moving to Done';
    }
    return null;
  }
}
```

This hook encodes one specific business rule: **Story and Epic issue types must have story points recorded before they can be marked Done.** Tasks (and other types) are exempt — they can go to Done without story points.

Three conditions must all be true for the hook to block:

1. `transition.toStatus?.category === StatusCategory.DONE` — the destination column is a "done" category column, not any arbitrary column named "Done". The check uses the enum category, which means a team could rename their Done column to "Shipped" and the rule would still fire correctly.
2. `issue.type === IssueType.STORY || issue.type === IssueType.EPIC` — only structured work-unit types are subject to this rule.
3. `issue.storyPoints == null` — uses loose equality (`==`) to catch both `null` and `undefined`, guarding against the case where the field was never set.

This hook is fully synchronous in nature (no DB calls) and returns without `await`. Marking it `async` is correct for interface conformance — it satisfies `Promise<string | null>` — but it never actually yields to the event loop.

---

### AutoActionExecutor — Deep Dive

`src/modules/workflow/AutoActionExecutor.ts`

```typescript
export class AutoActionExecutor {
  async execute(actions: WorkflowAutoAction[], issue: Issue, actorId: string): Promise<void> {
    const repo = AppDataSource.getRepository(Issue);

    for (const action of actions) {
      try {
        if (action.type === AutoActionType.ASSIGN_REVIEWER) {
          const config = action.config as { assignTo: 'current_user' | string };
          const assigneeId = config.assignTo === 'current_user' ? actorId : config.assignTo;
          await repo.update(issue.id, { assigneeId });
        }
        // Additional action types (SET_FIELD, NOTIFY) extend here
      } catch (err) {
        logger.error({ err, actionId: action.id }, 'Auto-action failed');
      }
    }
  }
}
```

Key design decisions:

1. **Best-effort semantics.** Every action is wrapped in `try/catch`. A failure logs the error with the `actionId` for traceability but does not throw — the caller receives no indication that an auto-action failed. This is intentional: the state transition itself succeeded, and the auto-action is a secondary effect. Throwing here would force the caller to roll back a legitimate state change because a Slack webhook timed out.

2. **`ASSIGN_REVIEWER` with `current_user` sentinel.** The `config` JSON can contain either a hardcoded user UUID or the string `"current_user"`. The executor resolves `"current_user"` to `actorId` at runtime. This lets teams configure "assign to whoever does the transition" without knowing in advance which team member will be doing the work.

3. **Sequential execution.** Like the hook runner, actions run in a `for...of` loop rather than `Promise.all`. If the `ASSIGN_REVIEWER` action fails, subsequent actions still run. Parallel execution would complete faster but make error correlation harder.

4. **Extension point.** The comment `// Additional action types (SET_FIELD, NOTIFY) extend here` signals where new `AutoActionType` cases should be added. The data model already supports arbitrary JSON `config`, so adding `SET_FIELD` with `{ "field": "priority", "value": "HIGH" }` requires only a new `if` branch in `execute`.

---

### WorkflowService — CRUD Layer

`src/modules/workflow/WorkflowService.ts`

```typescript
export class WorkflowService {
  constructor(private readonly repo: WorkflowRepository) {}

  getStatuses(projectId: string): Promise<WorkflowStatus[]> {
    return this.repo.findStatusesByProject(projectId);
  }

  createStatus(data: { projectId: string; name: string; category: StatusCategory; position?: number; wipLimit?: number | null }): Promise<WorkflowStatus> {
    return this.repo.saveStatus(data as Partial<WorkflowStatus>);
  }

  async updateStatus(id: string, data: Partial<{ name: string; position: number; wipLimit: number | null }>): Promise<WorkflowStatus> {
    const status = await this.repo.findStatusById(id);
    if (!status) throw new NotFoundError('WorkflowStatus', id);
    return this.repo.saveStatus({ ...status, ...data });
  }

  getAllowedTransitions(fromStatusId: string): Promise<WorkflowTransition[]> {
    return this.repo.findAllowedTransitions(fromStatusId);
  }

  createTransition(data: { projectId: string; fromStatusId: string; toStatusId: string; name?: string }): Promise<WorkflowTransition> {
    return this.repo.saveTransition(data as Partial<WorkflowTransition>);
  }
}
```

`WorkflowService` is the CRUD management layer — it is used by admin-facing API routes that let a project manager define the workflow topology. It is separate from `WorkflowEngine`, which handles runtime issue transitions.

The `updateStatus` method is the only one with a guard: it loads the existing record before saving (read-then-write) so that `saveStatus` performs an `UPDATE` rather than an `INSERT`. TypeORM's `.save()` distinguishes between insert and update based on the presence of a primary key in the data object.

**Note:** `WorkflowService` does not depend on `WorkflowEngine` and vice versa. They share `WorkflowRepository` as their data-access interface. This separation of concerns means that load tests or scripts can create workflow topologies via `WorkflowService` without triggering any FSM logic.

---

### Request Validation — workflowSchemas.ts

`src/modules/workflow/schemas/workflowSchemas.ts`

```typescript
export const createStatusSchema = Joi.object({
  name:     Joi.string().min(1).max(100).required(),
  category: Joi.string().valid('TODO', 'IN_PROGRESS', 'DONE').required(),
  position: Joi.number().integer().min(0).optional(),
  wipLimit: Joi.number().integer().min(1).allow(null).optional(),
});

export const transitionIssueSchema = Joi.object({
  toStatusId: Joi.string().uuid().required(),
});
```

Two schema decisions worth noting:

- `wipLimit: Joi.number().integer().min(1).allow(null)` — a WIP limit of `0` is not valid (Joi rejects integers below 1), but `null` is allowed to explicitly remove a previously set limit. This prevents the ambiguous case of `wipLimit: 0` which could be misread as "zero issues allowed" rather than "no limit".
- `toStatusId: Joi.string().uuid()` — Joi validates the UUID format before the request reaches the engine, so `WorkflowEngine.transition()` never sees malformed IDs that would silently return `null` from the repository.

---

### Adding a New Validation Hook

This is the key extension point for the workflow system. To add a new guard — say, a rule that blocks transitions out of "In Review" unless the issue has been approved by at least one reviewer — follow these three steps:

**Step 1: Create the hook file**

`src/modules/workflow/hooks/ReviewApprovalHook.ts`

```typescript
import { IValidationHook, TransitionContext } from './IValidationHook';
import { AppDataSource } from '../../../config/database';
import { IssueApproval } from '../../../models/IssueApproval';
import { StatusCategory } from '../../../core/types/enums';

export class ReviewApprovalHook implements IValidationHook {
  async validate(ctx: TransitionContext): Promise<string | null> {
    const { issue, transition } = ctx;

    // Only enforce on transitions that leave the IN_PROGRESS category
    if (ctx.transition.fromStatus?.category !== StatusCategory.IN_PROGRESS) {
      return null;
    }

    const approvalCount = await AppDataSource.getRepository(IssueApproval).count({
      where: { issueId: issue.id, approved: true },
    });

    if (approvalCount < 1) {
      return 'At least one reviewer approval is required before leaving review';
    }
    return null;
  }
}
```

**Step 2: Register the hook in WorkflowEngine**

In `src/modules/workflow/WorkflowEngine.ts`, add the import and include the new hook in the constructor array:

```typescript
import { ReviewApprovalHook } from './hooks/ReviewApprovalHook';

// Inside the class body:
private readonly hookRunner = new ValidationHookRunner([
  new WipLimitHook(),
  new RequiredFieldHook(),
  new ReviewApprovalHook(),   // <-- added here
]);
```

**Step 3: Write a unit test**

```typescript
// tests/unit/hooks/ReviewApprovalHook.test.ts
import { ReviewApprovalHook } from '../../../src/modules/workflow/hooks/ReviewApprovalHook';
import { StatusCategory } from '../../../src/core/types/enums';

describe('ReviewApprovalHook', () => {
  it('returns null when origin status is not IN_PROGRESS', async () => {
    const hook = new ReviewApprovalHook();
    const ctx = buildContext({ fromCategory: StatusCategory.TODO });
    expect(await hook.validate(ctx)).toBeNull();
  });

  it('returns error when no approvals exist', async () => {
    const hook = new ReviewApprovalHook();
    mockApprovalCount(0);
    const ctx = buildContext({ fromCategory: StatusCategory.IN_PROGRESS });
    expect(await hook.validate(ctx)).toMatch(/approval is required/);
  });
});
```

No changes to `ValidationHookRunner` or `WorkflowEngine.transition()` are needed. This is the Open/Closed Principle in action.

---

## Key Takeaways

- The workflow system is a **Finite State Machine** backed by the database: `WorkflowStatus` rows are nodes, `WorkflowTransition` rows are directed edges, and the absence of an edge is the only way to forbid a move.
- The **Strategy pattern** (via `IValidationHook`) keeps each validation rule isolated in its own class. Adding a new guard never requires modifying `WorkflowEngine` or `ValidationHookRunner`.
- `ValidationHookRunner` is a **Chain of Responsibility** that runs hooks sequentially and short-circuits on the first failure — cheap guards should be listed before expensive DB-querying guards to minimise unnecessary work.
- **WIP limits** are a Kanban concept grounded in queueing theory (Little's Law): capping work in progress reduces lead time by forcing teams to finish before starting new work. `WipLimitHook` enforces them at the DB count level on every transition attempt.
- **Auto Actions** are post-transition side effects that run outside the DB transaction and are best-effort: failures are logged but do not roll back the state change. This prevents secondary concerns (assignments, notifications) from breaking a legitimate workflow move.
- `WorkflowEngine` is deliberately separate from `WorkflowService`. The engine handles runtime issue transitions; the service handles workflow topology management (creating statuses and transition rules). They share `WorkflowRepository` but have no direct dependency on each other.
- The `WorkflowRepository.findTransition()` method eagerly joins `toStatus` and `autoActions` in a single query, avoiding N+1 problems that would otherwise arise if hooks and the executor had to lazy-load those relations individually.
- When a disallowed transition is attempted, the engine returns the **list of allowed next statuses** in the error payload, enabling the UI to show only valid transition options rather than a generic error message.

---

## Further Reading

- **Anderson, David J. — *Kanban: Successful Evolutionary Change for Your Technology Business* (2010)** — The definitive source on WIP limits, flow metrics, and the Kanban method as applied to software development teams.
- **Gamma, Erich; Helm, Richard; Johnson, Ralph; Vlissides, John — *Design Patterns: Elements of Reusable Object-Oriented Software* (1994)** — Covers Strategy (Chapter 5) and Chain of Responsibility (Chapter 5) in their original formulations with motivating examples.
- **Minsky, Marvin — *Computation: Finite and Infinite Machines* (1967)** — The foundational text on finite automata theory, covering FSM formal definitions, state transition tables, and the limits of what finite machines can compute.
- **Fowler, Martin — *Patterns of Enterprise Application Architecture* (2002)** — Chapter on Domain Model and the discussion of the State pattern (pages 395–397) is directly applicable to how workflow status transitions are modelled in TypeORM entities.
- **XState documentation — https://statemachines.dev** — A practical, well-written introduction to statecharts and FSMs in JavaScript/TypeScript, with interactive visualisers that make state diagrams tangible. The concepts map directly to what this codebase implements manually.
