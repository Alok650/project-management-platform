# ADR-002: CQRS for the Issues Module

**Status**: Accepted
**Date**: 2026-06-10

---

## Context

The Issues module has two sharply different performance profiles:

- **Board reads** are the hot path. A project board page is loaded by 100+ concurrent viewers during sprint ceremonies. The query joins `issues`, `issue_statuses`, and `users` (assignees) and is called on every page refresh.
- **Issue writes** (create, update, transition) are infrequent by comparison but require correctness guarantees. Concurrent updates to the same issue must not silently overwrite each other; optimistic locking is the preferred mechanism.

A single `IssueService` handling both concerns would either accept read-path performance compromises (no dedicated caching strategy) or introduce locking overhead into the read path.

## Decision

We split the Issues module into two services:

### `IssueCommandService` (writes)
- Handles create, update, delete, and workflow transitions.
- Uses TypeORM's `@VersionColumn` to implement optimistic locking. A stale-version write throws `OptimisticLockVersionMismatch`, surfaced as HTTP 409.
- After each mutating operation, publishes a domain event (`issue.created`, `issue.updated`, `issue.transitioned`) and **invalidates** the Redis board cache for the affected `projectId`.

### `IssueQueryService` (reads)
- Handles board view and single-issue fetches.
- Board view result is cached in Redis under the key `board:<projectId>` with a 30-second TTL.
- On cache miss, executes a single JOIN query across issues, statuses, and assignees, then writes the result to Redis.
- Has no knowledge of write concerns or locking.

Both services are injected into `IssueController`, which routes the incoming request to the appropriate service based on HTTP method.

## Consequences

**Positive**

- Read and write paths can be reasoned about and scaled independently.
- The Redis cache dramatically reduces database load for board views without affecting write correctness.
- Optimistic locking is isolated to the command path; readers are never blocked by locks.

**Negative / Trade-offs**

- Two services to maintain instead of one. Developers must be careful to invalidate the cache in every write path — a missed invalidation in `IssueCommandService` produces stale board state.
- Board viewers may see up to 30 seconds of stale data if cache invalidation is missed (see ADR-004 for the cache invalidation contract).
- The separation adds a small amount of cognitive overhead when tracing a full issue lifecycle.
