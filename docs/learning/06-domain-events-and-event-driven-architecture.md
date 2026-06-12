# Domain Events & Event-Driven Architecture

## What You'll Learn

- What a Domain Event is and how it models a real-world fact that has already occurred
- The Observer (Publisher/Subscriber) pattern and why it is the foundation of decoupled systems
- The difference between an in-process event bus and a distributed message broker like SQS or Kafka
- What Event-Driven Architecture (EDA) means and how it differs from direct method calls
- Eventual consistency: what the term means and how it relates to event-driven flows
- Why publishers must not know about their subscribers, and what breaks when they do
- What an Activity Log / Audit Trail is and why enterprise software demands one
- A line-by-line walkthrough of this codebase's `DomainEventBus`, event definitions, `ActivityService`, `NotificationService`, and `WebSocketService`
- The complete data-flow chain from a single HTTP request through to activity logging, notifications, and real-time broadcast

---

## Part 1 — Theory

### 1.1 What Is a Domain Event?

A Domain Event is a record of something significant that **has already happened** inside your system's domain. The past-tense framing is intentional: events are facts, not commands. A command says "please do X"; an event says "X has occurred."

Classic examples from the real world:

- *OrderPlaced* — a customer submitted a purchase order
- *PaymentReceived* — funds cleared
- *ShipmentDispatched* — a parcel left the warehouse

These events are immutable. You cannot un-place an order in the same way you cannot un-ring a bell. If a reversal is needed, you model it as a *new* event — *OrderCancelled* — rather than deleting the original.

The concept originates from Domain-Driven Design (DDD), introduced by Eric Evans in his 2003 book *Domain-Driven Design: Tackling Complexity in the Heart of Software*. Vaughn Vernon expanded on domain events extensively in *Implementing Domain-Driven Design* (2013). The core insight is that domain events are part of the ubiquitous language of a business: your CEO understands "an issue was transitioned to Done" far more naturally than "a row was updated in the `issues` table where `status_id` changed."

**Anatomy of a domain event:**

```typescript
// Generic concept — not from this codebase
interface DomainEvent {
  type: string;         // what happened, past tense
  occurredAt: Date;     // when the fact was recorded
  correlationId: string; // ties to the originating request for tracing
  payload: unknown;     // everything the receiver needs to react
}
```

Events carry just enough data for subscribers to act without needing to query back to the source. If a subscriber needs the issue title, either include it in the payload or accept that the subscriber will fetch it — both are valid trade-offs depending on event size vs. query cost.

---

### 1.2 The Observer Pattern: Publisher/Subscriber

The Observer pattern is one of the original Gang of Four (GoF) design patterns. Its structure is simple:

- A **subject** (also called publisher or event source) maintains a list of **observers** (also called subscribers or listeners).
- When the subject's state changes, it notifies all registered observers.
- Observers register themselves; the subject has no compile-time knowledge of who they are.

Pseudocode in plain language:

```typescript
// Publisher knows nothing about who is listening
class Button {
  private listeners: Array<(event: ClickEvent) => void> = [];

  addListener(fn: (event: ClickEvent) => void): void {
    this.listeners.push(fn);
  }

  click(): void {
    const event = { type: 'Clicked', at: new Date() };
    this.listeners.forEach(fn => fn(event));
  }
}

// Subscribers register themselves
const button = new Button();
button.addListener((e) => console.log('Analytics recorded click at', e.at));
button.addListener((e) => console.log('UI updated button state'));
// The Button class has no import for Analytics or UI — they are decoupled
```

The critical property: **the publisher does not import the subscriber**. This eliminates a class of circular dependency bugs and means you can add, remove, or replace subscribers without touching the publisher.

In the context of Domain-Driven Design, the pattern is elevated: the "publisher" is a domain object (or service), and events cross module boundaries without creating module-to-module dependencies.

---

### 1.3 In-Process Event Bus vs. a Distributed Message Broker

These are two very different technologies with similar surfaces:

| Dimension | In-Process Bus | Distributed Broker (SQS, Kafka, RabbitMQ) |
|---|---|---|
| Persistence | No — lives in RAM | Yes — messages survive process restart |
| Delivery guarantee | At-most-once (fire-and-forget) | At-least-once or exactly-once depending on config |
| Ordering | Synchronous call order (within same thread/tick) | Configurable; Kafka gives per-partition ordering |
| Retry on failure | No — handler errors are caught and logged | Yes — message is re-delivered until ACK'd |
| Latency | Sub-millisecond | Tens of milliseconds or more (network round-trip) |
| Multi-process | No — only subscribers on the same OS process receive events | Yes — any consumer across any machine |
| Operational cost | Zero — it's a library | High — broker must be deployed, monitored, scaled |
| Best for | Intra-service loose coupling | Cross-service or cross-process communication |

A common misconception is that an in-process bus gives you "the benefits of a message queue without the infrastructure." It gives you decoupling. It does not give you durability or retry. If your process crashes between a DB commit and the event `emit()` call, the event is lost and the subscriber never runs. For an activity feed this is generally acceptable. For a billing debit it is not.

The ADR-003 in this project makes this trade-off explicit: the in-process bus is chosen because there is no cross-service propagation requirement at the current deployment stage, and the operational overhead of a broker is not warranted. The SQS queue enters the picture only for the notification delivery leg — where external delivery (email, push) demands durability.

---

### 1.4 Event-Driven Architecture (EDA)

Event-Driven Architecture is a software design paradigm where components communicate primarily by producing and consuming events rather than calling each other's methods directly.

Compare these two designs for the same feature ("log an activity entry when an issue is created"):

**Direct call approach:**

```typescript
// IssueCommandService must know about ActivityService
class IssueCommandService {
  constructor(
    private issueRepo: IssueRepository,
    private activityService: ActivityService, // tight coupling
    private notificationService: NotificationService, // tight coupling
  ) {}

  async create(data: IssueData): Promise<Issue> {
    const issue = await this.issueRepo.save(data);
    await this.activityService.logCreated(issue); // synchronous side-effect
    await this.notificationService.notifyMembers(issue); // synchronous side-effect
    return issue;
  }
}
```

Problems with this approach:
- `IssueCommandService` must import `ActivityService` and `NotificationService`. If you later add a Slack integration, you must modify `IssueCommandService` — a module it has no conceptual relation to.
- If `notificationService.notifyMembers()` is slow or throws, the issue creation response is delayed or fails.
- Unit-testing `IssueCommandService` requires mocking two unrelated services.
- If you add a fourth subscriber (analytics, audit, webhooks), you keep editing `IssueCommandService`, violating the Open-Closed Principle.

**Event-driven approach:**

```typescript
// IssueCommandService knows only about the event bus
class IssueCommandService {
  constructor(private issueRepo: IssueRepository) {}

  async create(data: IssueData): Promise<Issue> {
    const issue = await this.issueRepo.save(data);
    eventBus.publish({ type: 'IssueCreated', payload: { issueId: issue.id, ... } });
    return issue; // immediately returns — subscribers run asynchronously
  }
}

// Each subscriber is registered independently, in a different module
activityService.subscribeToEvents();
notificationService.subscribeToEvents();
slackIntegration.subscribeToEvents(); // added later, zero change to IssueCommandService
```

The trade-offs are real:
- **Pro**: Publishers are ignorant of their effect surface. Adding a new side-effect is purely additive.
- **Pro**: The write path does not block on slow subscribers.
- **Con**: The system is harder to reason about synchronously. A developer reading `IssueCommandService.create()` cannot know from that file alone what side effects occur.
- **Con**: Errors in subscribers are silent from the publisher's perspective — the event bus catches and logs them, but no exception propagates back to the HTTP handler.
- **Con**: For in-process buses, a crash between DB write and event publish loses the event.

---

### 1.5 Eventual Consistency

Eventual consistency is a consistency model used in distributed computing and event-driven systems. It says: given no further updates, all reads will eventually return the same value. Contrast this with strong (linearizable) consistency, where every read sees the latest write immediately.

In an event-driven system, the activity log is updated *after* the primary write — by a subscriber that runs asynchronously. In theory there is a window where the issue exists in the database but no activity log entry exists for it. In practice for an in-process bus, this window is microseconds. For a distributed broker, it could be hundreds of milliseconds.

This is acceptable for an activity feed because:

1. Users read the activity feed seconds after an action, not within microseconds.
2. A stale-by-milliseconds feed does not cause business harm.
3. If the platform were a financial ledger, eventual consistency would be unacceptable and a different architecture would be required (e.g., writing the audit record *inside* the same database transaction as the primary write).

ADR-003 captures this directly: "a process crash between the write commit and the event emit could lose an activity entry. In practice the window is a few microseconds and is acceptable for an activity feed (not a financial ledger)."

---

### 1.6 Why Publishers Must Not Know About Subscribers

The moment a publisher has a reference to a specific subscriber, several problems compound:

**Coupling growth is super-linear.** If module A calls B, and B calls C, changing C's interface breaks B, which breaks A. With N modules and direct calls, you have O(N²) potential coupling paths. Events invert this: A publishes; B, C, D each register themselves. The change surface is local to each module.

**Testing becomes harder.** To unit-test A, you must mock B and C. If B has its own dependencies, the mock graph grows. With an event bus, testing A requires only that it publishes the correct event — no knowledge of how many subscribers exist.

**Deployment and team ownership conflicts.** In a microservices context, different teams own different services. If the Issue service directly calls the Notification service, the Issue team's deployment is blocked whenever the Notification team's API changes. With events, the Issue team publishes and stops thinking about it.

**The Open-Closed Principle.** Software entities should be open for extension but closed for modification. An event-driven publisher is maximally open for extension (any number of new subscribers) and closed for modification (no change needed when subscribers are added or removed).

---

### 1.7 Activity Logs and Audit Trails

An audit trail is an immutable, append-only log of every significant state change in a system, recording *who* did *what* to *which entity*, *when*, and *what changed*. Enterprise software demands audit trails for multiple reasons:

- **Regulatory compliance**: GDPR, SOC 2, HIPAA, and PCI DSS all require evidence of who accessed or modified sensitive data.
- **Debugging production incidents**: "What happened to this issue between Monday and Tuesday?" can only be answered by an audit log.
- **Business intelligence**: How long do issues stay in each status? Which team members are most active? These questions require a history, not just a current snapshot.
- **Accountability**: In a multi-user system, users need to see who made changes to shared resources.

An audit trail must be:
- **Immutable**: Rows are inserted, never updated or deleted. There is no `UPDATE activity_logs SET ...` in this codebase.
- **Machine-generated**: The application — not the user — writes entries. Users cannot edit the audit trail.
- **Comprehensive**: Every significant mutation is recorded, not just "important" ones. Importance is determined at query time, not write time.

In this codebase, the `ActivityLog` entity (at `src/models/ActivityLog.ts`) captures all of these properties. Its `@CreateDateColumn` is set by the database engine on insert, not by application code, making it tamper-resistant.

---

## Part 2 — Implementation Walkthrough

### 2.1 The Base `DomainEvent` Interface

**File: `src/core/events/DomainEvent.ts`**

```typescript
/** Base interface for all domain events */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}
```

Every event in the system extends this interface. Three fields are universally required:

- `type`: the discriminant string used by the event bus to route to the correct handler (e.g., `'IssueCreated'`).
- `occurredAt`: when the event was created. This is set at publish time, not at subscription time. If subscribers process events asynchronously with delay, `occurredAt` still reflects when the domain fact occurred.
- `correlationId`: the request-scoped trace ID threaded from the HTTP handler through to every downstream log line and event. This allows you to reconstruct the exact chain of calls that produced any given event using a structured log aggregator like Datadog or CloudWatch.

All three fields are `readonly`, which enforces immutability at the TypeScript level.

---

### 2.2 The `DomainEventBus`

**File: `src/core/events/DomainEventBus.ts`**

```typescript
import { EventEmitter } from 'events';
import { AppDomainEvent } from './events';
import { logger } from '../../infrastructure/logger/Logger';

class DomainEventBus extends EventEmitter {
  /** Publish a domain event to all subscribers */
  publish(event: AppDomainEvent): void {
    logger.debug({ eventType: event.type, correlationId: event.correlationId }, 'Domain event published');
    this.emit(event.type, event);
    this.emit('*', event);
  }

  /**
   * Subscribe to a specific event type or all events via '*'
   * @param eventType - Event type string or '*' for all events
   * @param handler   - Async or sync handler; errors are caught and logged
   */
  subscribe<T extends AppDomainEvent>(
    eventType: T['type'] | '*',
    handler: (event: T) => void | Promise<void>,
  ): void {
    this.on(eventType, (event: T) => {
      Promise.resolve(handler(event)).catch((err) =>
        logger.error({ err, eventType }, 'Event handler error'),
      );
    });
  }
}

export const eventBus = new DomainEventBus();
eventBus.setMaxListeners(50);
```

**How `publish()` works (lines 7–11):**

`publish()` calls Node.js's built-in `EventEmitter.emit()` twice:

1. `this.emit(event.type, event)` — fires the event on the specific channel (e.g., `'IssueCreated'`). Only subscribers that called `subscribe('IssueCreated', ...)` receive this.
2. `this.emit('*', event)` — fires on the wildcard channel. Any subscriber that called `subscribe('*', ...)` receives every event, regardless of type.

This dual-emit design allows both targeted subscriptions (`NotificationService` cares only about `CommentAdded`) and catch-all subscriptions (`ActivityService` wants every event).

**How `subscribe()` works (lines 13–27):**

The type parameter `<T extends AppDomainEvent>` narrows the handler argument to the specific event type. When you call `subscribe<CommentAddedEvent>('CommentAdded', handler)`, TypeScript knows that inside `handler`, `event.payload.mentions` exists and is `string[]`. This is compile-time safety — no runtime casting required.

The `Promise.resolve(handler(event)).catch(...)` wrapper is critical: it normalises synchronous and asynchronous handlers into a single promise chain, and ensures that an exception thrown inside a subscriber never propagates back up into `EventEmitter.emit()`. Without this, a single failing subscriber would crash the current call stack, which would mean a notification failure could cause the issue creation HTTP response to 500. With this wrapper, subscriber errors are logged and the publisher continues normally.

**Why a singleton (line 30):**

```typescript
export const eventBus = new DomainEventBus();
```

The entire application has one event bus instance. This is intentional: publishers import `eventBus` and call `.publish()`. Subscribers import the same `eventBus` and call `.subscribe()`. Because it is a module-level export, Node.js's module caching ensures all importers get the same object. If each service created its own `DomainEventBus`, publisher and subscriber would hold different instances and events would never be delivered.

`setMaxListeners(50)` raises Node.js's default warning threshold from 10 listeners to 50. The default is a memory-leak safeguard: Node warns if more than 10 listeners attach to the same event, because that is often a sign of subscriptions accumulating in a loop. This codebase has multiple services subscribing to `'*'` and specific events, which is expected and intentional.

**What the bus does NOT do:**

- It does not persist events to disk or a database. If the process dies, all undelivered events are lost.
- It does not retry failed handlers. A handler that throws (after the `catch`) is logged and dropped.
- It does not guarantee ordering across asynchronous handlers. Two subscribers to the same event will both fire, but if they both do async work, the order of their database writes is determined by I/O scheduling.
- It does not deliver events to subscribers on other OS processes or pods. A second Node.js process running in a separate container has its own `eventBus` instance with its own subscriber set.

---

### 2.3 The Event Catalogue

**File: `src/core/events/events.ts`**

```typescript
import { DomainEvent } from './DomainEvent';

export interface IssueCreatedEvent extends DomainEvent {
  readonly type: 'IssueCreated';
  readonly payload: { issueId: string; projectId: string; actorId: string };
}
export interface StatusChangedEvent extends DomainEvent {
  readonly type: 'StatusChanged';
  readonly payload: {
    issueId: string; projectId: string;
    fromStatusId: string; toStatusId: string; actorId: string;
  };
}
export interface IssueUpdatedEvent extends DomainEvent {
  readonly type: 'IssueUpdated';
  readonly payload: { issueId: string; projectId: string; changes: Record<string, unknown>; actorId: string };
}
export interface IssueMovedEvent extends DomainEvent {
  readonly type: 'IssueMoved';
  readonly payload: {
    issueId: string; projectId: string;
    fromSprintId: string | null; toSprintId: string | null; actorId: string;
  };
}
export interface CommentAddedEvent extends DomainEvent {
  readonly type: 'CommentAdded';
  readonly payload: { commentId: string; issueId: string; projectId: string; authorId: string; mentions: string[] };
}
export interface SprintUpdatedEvent extends DomainEvent {
  readonly type: 'SprintUpdated';
  readonly payload: { sprintId: string; projectId: string; actorId: string };
}

export type AppDomainEvent =
  | IssueCreatedEvent | StatusChangedEvent | IssueUpdatedEvent
  | IssueMovedEvent | CommentAddedEvent | SprintUpdatedEvent;
```

Every event type in the application is listed here. The union type `AppDomainEvent` is the contract between publisher and bus. The bus's `publish()` method accepts only `AppDomainEvent`, which means every event must be declared in this file. This is intentional: it creates a single catalogue of all domain facts in the system, making it easy to audit what the system considers significant.

**When each event is fired:**

| Event | Fired by | When |
|---|---|---|
| `IssueCreated` | `IssueCommandService.create()` | After a new issue row is persisted to the database |
| `IssueUpdated` | `IssueCommandService.update()` | After an issue's fields are updated (title, description, assignee, priority, labels) |
| `IssueMoved` | `IssueCommandService.update()` | Only when `sprintId` changes as part of an update; fires in addition to `IssueUpdated` |
| `StatusChanged` | `WorkflowEngine.transition()` | After a workflow state machine transition is validated and the new status is persisted |
| `CommentAdded` | (comment command service, wired similarly) | After a comment row is persisted; carries `mentions` array of tagged user IDs |
| `SprintUpdated` | (sprint command service) | After a sprint's properties (name, dates, goal) are changed or after start/complete |

The TypeScript discriminated union pattern means that when you write a `switch` over `event.type`, TypeScript narrows the event's type in each branch. Inside `case 'CommentAdded':`, the compiler knows `event.payload.mentions` exists; it would be a compile error to access `.mentions` in the `case 'IssueCreated':` branch.

---

### 2.4 Publishing an Event: `IssueCommandService`

**File: `src/modules/issues/IssueCommandService.ts`**

The issue creation path illustrates the canonical publish pattern:

```typescript
async create(
  projectId: string,
  data: Partial<Issue> & { type: string; title: string },
  actorId: string,
  correlationId: string,
): Promise<Issue> {
  // ... validation and key generation omitted for brevity

  const issue = await this.issueRepo.save({
    ...data,
    projectId,
    statusId,
    issueKey,
    reporterId: actorId,
    labels: (data.labels as string[] | undefined) ?? [],
  } as Partial<Issue>);

  eventBus.publish({
    type: 'IssueCreated',
    occurredAt: new Date(),
    correlationId,
    payload: { issueId: issue.id, projectId, actorId },
  } as IssueCreatedEvent);

  return issue;
}
```

**Why the publish happens after `issueRepo.save()`, not before:**

If the event were published before the database write, subscribers might query the database for the issue and find it does not exist yet. Worse, if the `save()` subsequently threw an exception (a unique constraint violation, a network error), the event would have already been delivered — subscribers would have logged an activity entry and sent notifications for an issue that was never created. Publishing *after* a successful write ensures the event represents a committed fact.

The same logic applies to the `update()` method, where both `IssueUpdated` and conditionally `IssueMoved` are published only after the transaction commits:

```typescript
const updated = await AppDataSource.transaction(async (em) => {
  return em.save(Issue, { ...issue, ...changes, version: data.version });
});

eventBus.publish({
  type: 'IssueUpdated',
  occurredAt: new Date(),
  correlationId,
  payload: { issueId, projectId: issue.projectId, changes: changes as Record<string, unknown>, actorId },
} as IssueUpdatedEvent);

if (sprintChanged) {
  eventBus.publish({
    type: 'IssueMoved',
    // ...
  } as IssueMovedEvent);
}
```

The transaction commits before either event is published. A sprint change publishes two events — this is valid. `IssueUpdated` records the generic field change; `IssueMoved` is a richer semantic event that allows sprint board subscribers to know the specific before/after sprint without parsing `changes`.

---

### 2.5 The `ActivityLog` Schema

**File: `src/models/ActivityLog.ts`**

```typescript
@Entity('activity_logs')
@Index('idx_activity_project_created', ['projectId', 'createdAt'])
@Index('idx_activity_entity', ['entityType', 'entityId'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ name: 'actor_id' })
  actorId!: string;

  @Column({ name: 'entity_type', length: 50 })
  entityType!: string;         // 'ISSUE', 'COMMENT', 'SPRINT', 'PROJECT'

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'enum', enum: ActivityAction })
  action!: ActivityAction;     // CREATED, UPDATED, STATUS_CHANGED, COMMENT_ADDED

  @Column({ name: 'old_value', type: 'json', nullable: true })
  oldValue!: Record<string, unknown> | null;  // e.g., { statusId: 'abc' }

  @Column({ name: 'new_value', type: 'json', nullable: true })
  newValue!: Record<string, unknown> | null;  // e.g., { statusId: 'xyz' }

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;
}
```

Key design choices:

- `entityType` + `entityId` form a polymorphic reference. A single `activity_logs` table stores events for issues, comments, and sprints without separate tables per entity type. The two composite indexes (`idx_activity_project_created` and `idx_activity_entity`) support the two query patterns: "all recent activity in project P" and "all activity on entity E".
- `oldValue` and `newValue` are JSON columns. For `StatusChanged`, `oldValue` is `{ statusId: 'abc' }` and `newValue` is `{ statusId: 'xyz' }`. For `IssueUpdated`, `newValue` carries the full `changes` map from the event payload. This allows the UI to display before/after diffs without further queries.
- `createdAt` uses `@CreateDateColumn`, which is set by the ORM at insert time. It is `readonly` in TypeScript to prevent accidental mutation.
- There is no `updated_at` column. Activity log rows are never updated — this is the append-only requirement.

---

### 2.6 `ActivityService`: Subscribing to All Events

**File: `src/modules/activity/ActivityService.ts`**

```typescript
export class ActivityService {
  constructor(private readonly repo: ActivityRepository) {
    this.subscribeToEvents();
  }

  /** Register all domain event → activity log mappings */
  private subscribeToEvents(): void {
    eventBus.subscribe<AppDomainEvent>('*', async (event) => {
      const entry = this.toActivityEntry(event);
      if (entry) await this.repo.save(entry);
    });
  }

  /** Map a domain event to an ActivityLog insert payload; returns null for unmapped events */
  private toActivityEntry(event: AppDomainEvent): Partial<ActivityLog> | null {
    switch (event.type) {
      case 'IssueCreated':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.CREATED,
        };
      case 'StatusChanged':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.STATUS_CHANGED,
          oldValue: { statusId: event.payload.fromStatusId },
          newValue: { statusId: event.payload.toStatusId },
        };
      case 'IssueUpdated':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.UPDATED,
          newValue: event.payload.changes,
        };
      case 'CommentAdded':
        return {
          projectId: event.payload.projectId, actorId: event.payload.authorId,
          entityType: 'COMMENT', entityId: event.payload.commentId, action: ActivityAction.COMMENT_ADDED,
        };
      default:
        return null;
    }
  }
}
```

`ActivityService` uses the `'*'` wildcard subscription — it receives every event published on the bus. The `toActivityEntry()` method is a mapping function: it translates the generic domain event into a concrete `ActivityLog` row. For events that should not produce an activity entry (e.g., `IssueMoved` and `SprintUpdated` return `null` from the `default` case), the entry is simply not saved. This design allows new event types to be added to the bus without `ActivityService` automatically generating junk rows — only explicitly handled cases produce entries.

Notice that for `CommentAdded`, the `actorId` is taken from `event.payload.authorId` (not `actorId`) because the comment author is the actor for the activity entry. This small asymmetry is handled cleanly in the mapping layer rather than adding a second field to the event.

The constructor calls `this.subscribeToEvents()` immediately. `ActivityService` is instantiated at application bootstrap (as noted in ADR-003: "instantiated at bootstrap (`src/server.ts`) so its event subscriptions are registered before the first request is accepted"). If instantiation were deferred until the first HTTP request, any events published before the first request would be missed.

---

### 2.7 `ActivityRepository`: Cursor-Paginated Feed

**File: `src/modules/activity/ActivityRepository.ts`**

The `listByProject()` method serves the activity feed API:

```typescript
async listByProject(
  projectId: string,
  filters: { entityType?: string; entityId?: string; actorId?: string },
  cursor?: string,
  limit = 50,
): Promise<CursorPage<ActivityLog>> {
  const qb = this.repo.createQueryBuilder('a')
    .leftJoinAndSelect('a.actor', 'actor')
    .where('a.projectId = :projectId', { projectId })
    .orderBy('a.createdAt', 'DESC')
    .addOrderBy('a.id', 'DESC')
    .limit(limit + 1);
  // ... filter conditions and cursor decode omitted
}
```

Cursor pagination is used rather than offset pagination (`LIMIT x OFFSET y`) for two reasons:

1. **Consistency**: If a new activity entry is inserted between page 1 and page 2 reads, offset pagination shifts all subsequent rows, causing a row to appear twice or be skipped. Cursor pagination anchors on a specific row (by `createdAt` + `id`) and is immune to concurrent inserts.
2. **Performance**: `OFFSET y` requires the database to scan and discard `y` rows before returning results. For large tables, this degrades quadratically. Cursor-based `WHERE createdAt < :cursor` uses the `idx_activity_project_created` index efficiently regardless of page depth.

The compound sort on `createdAt DESC, id DESC` ensures a stable order when two entries share the same timestamp (which can happen when the bus delivers synchronously).

---

### 2.8 The Activity Feed API

**File: `src/modules/activity/routes/v1/activityRoutes.ts`**

```typescript
activityRouter.get(
  '/projects/:projectId/activity',
  requireProjectRole(ProjectRole.VIEWER),
  ActivityController.list
);
```

The route requires `VIEWER` role — the minimum project membership level. This is appropriate: any project member should be able to see the activity feed. The controller accepts optional query parameters `entityType`, `entityId`, and `actorId` for filtering, plus `cursor` and `limit` for pagination.

A sample API call to retrieve all activity on a specific issue:

```bash
GET /api/v1/projects/proj-123/activity?entityType=ISSUE&entityId=issue-456&limit=20
```

---

### 2.9 `NotificationService`: Targeted Subscriptions

**File: `src/modules/notifications/NotificationService.ts`**

Unlike `ActivityService`'s wildcard subscription, `NotificationService` subscribes only to the events it cares about:

```typescript
private subscribeToEvents(): void {
  eventBus.subscribe<CommentAddedEvent>('CommentAdded', async (event) => {
    for (const mentionedUserId of event.payload.mentions) {
      await this.deliver({
        userId:     mentionedUserId,
        type:       NotifType.MENTIONED,
        entityType: 'COMMENT',
        entityId:   event.payload.commentId,
        message:    'You were mentioned in a comment',
      });
    }
  });

  eventBus.subscribe<IssueCreatedEvent>('IssueCreated', async (event) => {
    logger.debug({ event: event.type }, 'IssueCreated notification hook (no assignee in payload)');
  });
}
```

For `CommentAdded`, the handler iterates `event.payload.mentions` — a list of user IDs that were `@mentioned` in the comment body. Each mentioned user gets an individual notification row. This is a fan-out pattern: one event produces N database writes, one per recipient.

The `deliver()` method wraps delivery in a circuit breaker:

```typescript
async deliver(data: { userId: string; type: NotifType; ... }): Promise<void> {
  try {
    await this.cb.execute(async () => {
      const saved = await this.repo.save({ ...data, read: false });
      logger.debug({ notificationId: saved.id, userId: data.userId }, 'Notification delivered');
    });
  } catch (err) {
    // Circuit is open — queue for later delivery
    logger.warn({ err, userId: data.userId }, 'Circuit open — queuing notification');
    await enqueueNotification({ notificationId, ...data })
      .catch((sqsErr) => {
        logger.error({ sqsErr }, 'Failed to enqueue notification to SQS');
      });
  }
}
```

The circuit breaker monitors failure rate. If the database or downstream notification transport starts failing repeatedly, the breaker opens and subsequent `deliver()` calls skip directly to SQS enqueue. This prevents a failing notification subsystem from spawning thousands of slow, timeout-bound database calls. SQS acts as the durable fallback: even if the main path fails, the message is not lost — a consumer will drain the queue when the downstream recovers.

**The `Notification` schema** (`src/models/Notification.ts`):

```typescript
@Entity('notifications')
@Index('idx_notifications_user_read_created', ['userId', 'read', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'enum', enum: NotifType })
  type!: NotifType;       // 'MENTIONED', 'ASSIGNED', etc.

  @Column({ name: 'entity_type', length: 50 })
  entityType!: string;

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'boolean', default: false })
  read!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;
}
```

The composite index `idx_notifications_user_read_created` is optimised for the most common query: "give me all unread notifications for user X, newest first." The `read` field is the only mutable column — `markAllRead()` sets it to `true` in bulk.

---

### 2.10 `WebSocketService`: Real-Time Broadcast

**File: `src/modules/websocket/WebSocketService.ts`**

`WebSocketService` is the third major subscriber. It also uses the wildcard subscription:

```typescript
// Subscribe to all domain events and broadcast to the relevant project room
eventBus.subscribe<AppDomainEvent>('*', async (event) => {
  const projectId = this.extractProjectId(event);
  if (projectId) {
    await this.broadcastToRoom(projectId, event);
    await this.appendToReplayBuffer(projectId, event);
  }
});
```

`extractProjectId()` reads `event.payload.projectId` via a dynamic property access, exploiting the fact that every event type in this codebase carries `projectId` in its payload. This avoids a separate `switch` statement that would need to be updated every time a new event type is added.

**Rooms**: Connected WebSocket clients are grouped by `projectId`. When a user connects to `ws://host/ws?projectId=proj-123&userId=user-456`, they are added to the `rooms.get('proj-123')` Set. `broadcastToRoom()` serialises the raw event as JSON and sends it to every open connection in that Set.

**Event replay**: Before returning from `broadcastToRoom()`, each event is also appended to a Redis Sorted Set with the current Unix timestamp as the score (`appendToReplayBuffer()`). When a client reconnects after a network interruption, it can pass `?since=<unixMs>` in the connection URL. The service will replay all events from the Sorted Set with score greater than `sinceMs`, bridging the gap:

```typescript
private async replayEvents(ws: ExtendedWebSocket, projectId: string, sinceMs: number): Promise<void> {
  const key    = CacheKeys.events(projectId);
  const events = await redis.zrangebyscore(key, sinceMs + 1, '+inf');
  for (const raw of events) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}
```

The buffer is bounded: events older than `REPLAY_WINDOW_SECONDS` are trimmed, and the set is hard-capped at `REPLAY_BUFFER_MAX_ITEMS` entries per project to prevent unbounded Redis growth.

---

### 2.11 The Complete Event Flow: Issue Creation

Here is the full chain from HTTP request to all three subscribers, using issue creation as the example:

```
HTTP POST /api/v1/projects/:id/issues
           │
           ▼
  IssueController.create()
           │  extracts actorId, correlationId
           ▼
  IssueCommandService.create()
           │  1. validates project exists
           │  2. resolves default status (TODO)
           │  3. generates issue key (atomic counter)
           │  4. issueRepo.save()  ◄─── DB WRITE COMMITS HERE
           │
           │  5. eventBus.publish(IssueCreatedEvent)
           │        │
           │        ├──── emit('IssueCreated', event)
           │        │          │
           │        │          └──► NotificationService handler
           │        │                    (IssueCreated hook — logs debug,
           │        │                     future: notify assignee)
           │        │
           │        └──── emit('*', event)
           │                   │
           │                   ├──► ActivityService handler
           │                   │         │
           │                   │         └── toActivityEntry() returns:
           │                   │             { entityType:'ISSUE',
           │                   │               entityId: issue.id,
           │                   │               action: CREATED,
           │                   │               projectId, actorId }
           │                   │             │
           │                   │             └── ActivityRepository.save()
           │                   │                   └── INSERT INTO activity_logs
           │                   │
           │                   └──► WebSocketService handler
           │                             │
           │                             ├── broadcastToRoom(projectId, event)
           │                             │     └── client.send(JSON.stringify(event))
           │                             │         for each connected WS client
           │                             │
           │                             └── appendToReplayBuffer(projectId, event)
           │                                   └── redis.zadd(events:proj-123, now, event)
           │
           ▼
  return issue  ──► HTTP 201 response to caller
```

The caller receives the HTTP 201 response without waiting for the activity log write, the notification delivery, or the WebSocket broadcast. `IssueCommandService` has zero imports from `ActivityService`, `NotificationService`, or `WebSocketService`. The only shared dependency is the `eventBus` singleton.

---

### 2.12 Multi-Pod Considerations

The in-process bus works correctly in single-pod deployments. In a horizontally scaled deployment where multiple Node.js pods are running behind a load balancer, each pod has its own `eventBus` instance. A write handled by Pod A publishes the event only to Pod A's subscribers. Pod B's `WebSocketService` will not broadcast the event to clients connected to Pod B.

ADR-003 acknowledges this: "In a multi-pod deployment, the in-process bus only delivers to subscribers on the same pod. For multi-pod WebSocket broadcasts the EventBus must be supplemented with a Redis Pub/Sub channel."

The architectural pattern for multi-pod EDA is:

```
Pod A publishes IssueCreated
  → Pod A's subscribers run locally (ActivityService, NotificationService)
  → Pod A also publishes to Redis Pub/Sub channel "domain-events:proj-123"

Pod B subscribes to Redis Pub/Sub channel "domain-events:proj-123"
  → Pod B's WebSocketService receives the event from Redis
  → broadcasts to its connected clients
```

This is an additive change — the `DomainEventBus` interface remains unchanged; a Redis bridge subscriber is added at bootstrap.

---

## Key Takeaways

- **Domain Events are immutable facts**, not commands. They record what happened, in past tense, and are never updated or deleted after publication.
- **The bus decouples by inversion**: publishers emit events; subscribers register themselves. `IssueCommandService` has no import from `ActivityService`, `NotificationService`, or `WebSocketService` — adding a new subscriber requires zero changes to any publisher.
- **The wildcard `'*'` subscription** (used by `ActivityService` and `WebSocketService`) means catch-all consumers automatically receive new event types without any code change, as long as new event types carry `projectId` in their payload.
- **Publish after commit, not before**: events are emitted only after the primary database write succeeds. Publishing before a write creates phantom events for data that may never be persisted.
- **The in-process bus guarantees nothing except delivery**: no persistence, no retry, no ordering guarantees beyond same-tick synchrony. For durability (notifications), the SQS queue supplements the bus.
- **The circuit breaker in `NotificationService`** prevents a cascading failure — a slow or failing notification database does not back-pressure into the event bus or the write path, and messages are preserved in SQS for later delivery.
- **Eventual consistency is a deliberate, documented trade-off**: the activity log may lag the primary write by microseconds. For an activity feed this is acceptable. For a financial audit requiring strict consistency, the audit write must be inside the same database transaction as the primary write.
- **Multi-pod deployments require a Redis Pub/Sub bridge**: the in-process bus is single-process by definition. Real-time WebSocket broadcasts in a scaled deployment require the event to be forwarded via Redis to all pods.

---

## Further Reading

- **Eric Evans — *Domain-Driven Design: Tackling Complexity in the Heart of Software*** (2003, Addison-Wesley): The foundational text that introduced domain events as a first-class modelling concept. Chapter 8 covers domain events in detail.

- **Vaughn Vernon — *Implementing Domain-Driven Design*** (2013, Addison-Wesley): Provides concrete implementation guidance for domain events, including how to publish them after transaction commit and how to use them across bounded contexts. Part III is dedicated to domain events.

- **Martin Fowler — "What do you mean by 'Event-Driven'?"** (2017): https://martinfowler.com/articles/201701-event-driven.html — a concise article distinguishing four different meanings of "event-driven" (event notification, event-carried state transfer, event sourcing, CQRS) and the trade-offs of each. Read this before designing any event-driven system.

- **Greg Young — "CQRS and Event Sourcing"** (GOTO 2014 conference talk, available on YouTube): Greg Young is the originator of CQRS and a key voice on event sourcing. This talk explains the philosophical connection between domain events, command/query separation, and append-only event stores.

- **Node.js Documentation — EventEmitter**: https://nodejs.org/api/events.html — the Node.js built-in that underpins `DomainEventBus`. Understanding `emit()`, `on()`, `removeListener()`, `setMaxListeners()`, and error handling is prerequisite knowledge for working with this codebase's event bus.
