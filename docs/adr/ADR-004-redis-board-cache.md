# ADR-004: Redis Board State Cache

**Status**: Accepted
**Date**: 2026-06-10

---

## Context

The project board view is the most frequently accessed read in the system. Rendering the board requires joining the `issues` table with `issue_statuses` (for column grouping) and `users` (for assignee avatars). With 100+ concurrent viewers during a sprint planning session, running this JOIN on every request creates unacceptable load on MySQL.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| No cache — query MySQL every time | Always fresh | Unacceptable at 100+ RPS on a complex JOIN |
| Application-level in-memory cache | Zero network hop | Not shared across pods; stale after pod restart |
| Redis String cache per project | Shared across pods; TTL-based safety net | Slight staleness window; requires cache invalidation discipline |
| Materialised view in MySQL | Always consistent | Schema migration required; still a DB read on every request |

Redis was already a runtime dependency (rate limiter, JWT blacklist), making a Redis cache the lowest-overhead addition.

## Decision

`IssueQueryService` caches the full board state for each project as a JSON-serialised string in Redis:

- **Key format**: `board:<projectId>`
- **TTL**: 30 seconds (configurable via `env.BOARD_CACHE_TTL_SECS`)
- **Serialisation**: `JSON.stringify` of the board DTO returned to the client
- **Invalidation**: `IssueCommandService` calls `redis.del('board:<projectId>')` after any write that mutates board-visible state (create, update, delete, transition, sprint assignment)

**Cache miss flow**:
1. `GET board:<projectId>` returns nil.
2. Execute `IssueQueryService.buildBoardQuery()` — single LEFT JOIN across issues, statuses, assignees.
3. `SET board:<projectId> <json> EX 30`.
4. Return DTO.

**Cache hit flow**:
1. `GET board:<projectId>` returns JSON string.
2. `JSON.parse` and return immediately — no database query.

The 30-second TTL acts as a safety net: even if an invalidation call is missed (e.g. a bug in a future write path), the cache self-heals within 30 seconds.

## Consequences

**Positive**

- Board view database load drops to near-zero during hot-path reads once the cache is warm.
- The cache key is scoped to `projectId`, so a write in Project A never evicts Project B's cache.
- TTL provides a guaranteed staleness upper bound without requiring perfect invalidation coverage.

**Negative / Trade-offs**

- Viewers may see board state up to 30 seconds out of date if a cache invalidation is missed. This is accepted as equivalent behaviour to tools like Jira, which also have eventual-consistency board views.
- Every `IssueCommandService` write path must remember to invalidate the cache. A checklist item should be added to the PR template for new issue write operations.
- In a Redis Cluster topology the `DEL` command must target the correct shard; ensure `projectId`-based hash tags are used if cluster mode is enabled (e.g. key `{projectId}:board`).
