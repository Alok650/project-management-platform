# ADR-003: Domain Events for Activity Feed and Notifications

**Status**: Accepted
**Date**: 2026-06-10

---

## Context

The activity feed and notification system must react to changes across multiple modules — issue creates/updates/transitions, comment posts, sprint starts/completions. There are two problematic design alternatives:

1. **Direct service calls**: `IssueCommandService` calls `ActivityService` and `NotificationService` inline. This creates circular dependency risk, increases coupling, and means a slow/failing notification delivery blocks the issue write response.
2. **External message broker** (Kafka, RabbitMQ): Robust but operationally heavy for a single-process service that has no requirement for cross-service event propagation at this stage.

We need loose coupling without the operational overhead of a distributed broker.

## Decision

We implement an **in-process typed `EventBus`** — a thin wrapper around Node.js `EventEmitter` — that publishes strongly-typed domain events. The bus is a singleton registered at bootstrap.

**Publishers** (command services) emit events after a successful write:
```
eventBus.emit('issue.created', { issueId, projectId, actorId, ... })
eventBus.emit('issue.transitioned', { issueId, fromStatus, toStatus, ... })
eventBus.emit('comment.created', { commentId, issueId, ... })
```

**Subscribers** are registered at startup:
- `ActivityService` subscribes via a wildcard pattern and writes a structured activity row to MySQL for every domain event it recognises.
- `NotificationService` subscribes to events that involve `@mentions` or watcher lists and enqueues a delivery job to SQS/ElasticMQ.

A **circuit breaker** (with Redis-backed state so all pods share it — see `docs/SCALING.md`) wraps outbound notification delivery. If the downstream notification transport (email/webhook) becomes unhealthy, the breaker opens and failed events are dead-lettered to an SQS DLQ rather than retried inline.

`ActivityService` is instantiated at bootstrap (`src/server.ts`) so its event subscriptions are registered before the first request is accepted.

## Consequences

**Positive**

- Write path (e.g. `IssueCommandService`) completes without waiting for activity logging or notification delivery.
- Adding a new side-effect (e.g. Slack integration) requires only a new subscriber — zero changes to existing publishers.
- The in-process bus has sub-millisecond delivery latency; activity feed consistency is effectively immediate in single-pod deployments.
- No distributed broker to operate or monitor for the current deployment topology.

**Negative / Trade-offs**

- **Eventual consistency**: in theory, a process crash between the write commit and the event emit could lose an activity entry. In practice the window is a few microseconds and is acceptable for an activity feed (not a financial ledger).
- In a multi-pod deployment, the in-process bus only delivers to subscribers on the same pod. For multi-pod WebSocket broadcasts the EventBus must be supplemented with a Redis Pub/Sub channel (see `docs/SCALING.md`).
- Notification failures are queued to SQS; a consumer must be running to drain the queue, adding an operational dependency.
