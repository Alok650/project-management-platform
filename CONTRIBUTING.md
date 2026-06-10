# Contributing

## Prerequisites

- Node.js 20+
- Docker & Docker Compose

## Local setup

```bash
# Install dependencies
npm install

# Start local services (MySQL, Redis, ElasticMQ)
docker compose up -d

# Copy environment template and fill in values
cp .env.example .env

# Run database migrations
npm run migration:run

# Seed demo data (optional)
npm run seed

# Start dev server with hot-reload
npm run dev
```

The API is available at `http://localhost:3000`.
Swagger UI at `http://localhost:3000/api-docs`.

## Running tests

```bash
npm test                    # all tests
npm run test:unit           # unit tests only
npm run test:integration    # integration tests (requires running Docker services)
npm run typecheck           # TypeScript type-check only
```

## Submitting a PR

1. Branch from `main`
2. Keep commits focused — use conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`
3. Ensure `npm test` and `npm run typecheck` pass locally before opening a PR
4. Fill in the pull request template
