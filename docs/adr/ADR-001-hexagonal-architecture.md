# ADR-001: Hexagonal Architecture (Ports and Adapters)

**Status**: Accepted
**Date**: 2026-06-10

---

## Context

The product management platform needs to remain maintainable as infrastructure choices evolve. Early-stage projects frequently swap persistence backends (e.g. MySQL to Postgres), caching layers (Redis to Memcached), or queue providers (SQS to RabbitMQ). Without explicit layer boundaries, infrastructure concerns bleed into business logic, making such changes costly and risky.

Additionally, the team needs confidence that business rules can be verified in fast, isolated unit tests — without spinning up a database or cache.

## Decision

We adopt **hexagonal architecture** (ports and adapters), organised into the following ordered layers for each module:

```
HTTP Request
    │
    ▼
routes/          — Koa Router; validates HTTP shape, delegates to controller
    │
    ▼
controller/      — Orchestrates one use-case; calls manager or service
    │
    ▼
manager/         — Optional composition layer for complex workflows (e.g. SprintManager)
    │
    ▼
service/         — Pure business logic; depends only on repository interfaces (ports)
    │
    ▼
repository/      — TypeORM adapter implementing the repository port; the only layer
                   that touches the database
```

**Domain events** (published via an in-process typed `EventBus`) decouple side-effects — activity logging, notifications, WebSocket broadcasts — from the write path. Modules communicate exclusively through events; direct cross-module service calls are prohibited.

Each module lives under `src/modules/<module>/` and owns its own routes, controller, service(s), repository, and entities. Shared infrastructure (logger, metrics, Redis client, EventBus) lives in `src/infrastructure/` or `src/config/`.

## Consequences

**Positive**

- Infrastructure can be replaced by swapping the adapter (repository implementation) without touching the service layer.
- Services accept injected repository interfaces, so unit tests mock the interface rather than the database.
- Domain-event coupling keeps modules loosely joined; adding a new side-effect (e.g. Slack notification) requires no changes to the write path.
- Onboarding is predictable: every module follows the same folder convention.

**Negative / Trade-offs**

- More files and indirection than a flat MVC layout. A simple CRUD endpoint now spans route → controller → service → repository.
- Developers must resist the temptation to call cross-module services directly; the event bus discipline must be enforced in code review.
