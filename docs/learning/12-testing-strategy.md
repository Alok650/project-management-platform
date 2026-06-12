# Testing Strategy

## What You'll Learn

- The testing pyramid: why unit, integration, and E2E tests each have different cost, speed, and confidence trade-offs
- The precise meaning of mock, stub, and spy — and when each is the right tool
- What test isolation means and the concrete bugs that emerge when tests share state
- How supertest lets you exercise HTTP routes without starting a real server or binding a port
- What Jest is and how its core constructs — `describe`, `it`, `beforeEach`, `afterAll`, `expect`, `jest.fn()`, `jest.mock()` — work together
- The principle of "test behaviour, not implementation" and why testing internal state leads to brittle test suites
- How Jest's module-level mock hoisting works and why mocks must be declared before any `import` statement
- A detailed walkthrough of every configuration option in `jest.config.ts`
- The mock strategy used across this codebase and the reasoning behind it
- Step-by-step walkthroughs of integration tests, unit tests, concurrency tests, and circuit-breaker state machine tests
- How to add a new test for a new module following the established pattern

---

## Part 1 — Theory

### 1.1 The Testing Pyramid

The testing pyramid is a model that describes three layers of automated tests, ordered from bottom to top by quantity, speed, and isolation level.

```
        /\
       /  \
      / E2E\         ← few, slow, high confidence on full flows
     /------\
    /        \
   /Integration\     ← medium count, medium speed, tests module boundaries
  /------------\
 /              \
/   Unit Tests   \   ← many, fast, tests one unit in isolation
/________________\
```

**Unit tests** verify a single class, function, or module in complete isolation. Every external collaborator is replaced with a controlled fake. A unit test for a login function does not talk to a database or hash passwords for real — it calls the function with known inputs and asserts on the return value and which fakes were called. Unit tests run in milliseconds and you should have hundreds of them.

**Integration tests** wire multiple real modules together (usually two or three layers deep) but still stop at infrastructure boundaries. In this codebase that means the Koa app factory runs for real, middleware executes, route handlers call controllers, but the database client and Redis client are mocked at module level. These tests verify that modules collaborate correctly — that a controller calls the right manager method, that middleware rejects missing tokens, that validation errors produce a `400` response. They run in tens to hundreds of milliseconds each.

**End-to-end (E2E) tests** drive the full stack — a real database with real data, a real Redis instance, a real running server — and issue HTTP requests just as a client would. They are the most expensive to write and maintain: they are slow (seconds each), flaky in CI without careful orchestration, and require real infrastructure to be running. The payoff is the highest confidence: they prove the whole system behaves correctly under production-like conditions. This project has load tests (under `load-tests/`) that serve a similar purpose.

**Why does the shape matter?** Each layer up the pyramid is more expensive — in execution time, in flakiness risk, and in the effort required when something changes. A test that can be written as a unit test should be. Only write an integration test when you need to verify that two modules collaborate correctly. Only write E2E tests for the critical user journeys where the cost of a production bug exceeds the cost of test maintenance.

---

### 1.2 Mocks, Stubs, and Spies

These three terms describe three different kinds of test doubles. They are often conflated, but each has a precise meaning.

**Stub** — A replacement that returns a predetermined value. Its sole purpose is to control what a dependency returns so the code under test can execute. You do not assert against a stub.

```typescript
// Pseudocode: stub
const stubUserRepo = {
  findByEmail: async () => null,  // always returns null — user not found
};
```

**Mock** — A replacement that records how it was called so you can assert against it later. Mocks answer the question "was this dependency called, with what arguments, how many times?"

```typescript
// Pseudocode: mock
const mockEmailSender = {
  send: jest.fn(),
};

// After exercising the code under test:
expect(mockEmailSender.send).toHaveBeenCalledWith(
  'alice@example.com',
  expect.stringContaining('Welcome'),
);
```

**Spy** — A wrapper around a real implementation that also records calls. The underlying function still runs; you just observe it.

```typescript
// Pseudocode: spy
const spy = jest.spyOn(bcrypt, 'hash');
// bcrypt.hash still executes for real, but calls are recorded
expect(spy).toHaveBeenCalledWith('plain_password', 12);
```

**When to use each:**

- Use a **stub** when you need to control what a collaborator returns (e.g., "pretend the DB has no user") but you do not care whether it was called.
- Use a **mock** when the calling behaviour is itself what you are testing (e.g., "the logout service must write to Redis exactly once").
- Use a **spy** when you want to verify calls but do not want to lose the real implementation (e.g., spying on a utility function while keeping its logic intact).

In Jest, `jest.fn()` creates a function that is both a stub (you can program its return value with `.mockResolvedValue(...)`) and a mock (it records all calls). `jest.spyOn()` creates a spy. In practice, the codebase uses `jest.fn()` almost exclusively because infrastructure collaborators (DB, Redis, SQS) must not execute for real in unit or integration tests.

---

### 1.3 Test Isolation

Test isolation means each test starts from a completely clean state. Tests that share state produce non-deterministic results — a test may pass in isolation but fail when run in a particular order.

Consider this non-isolated example:

```typescript
// Anti-pattern: tests share a counter
let callCount = 0;
const mockSave = jest.fn(() => { callCount++; });

it('test A', async () => {
  await service.create(...);
  expect(callCount).toBe(1);  // passes when run alone
});

it('test B', async () => {
  await service.create(...);
  expect(callCount).toBe(1);  // FAILS when run after test A — callCount is 2
});
```

This codebase solves the isolation problem with two patterns:

1. `jest.clearAllMocks()` in `beforeEach` — resets call counts and return values on every `jest.fn()` so each test starts with a fresh mock state.
2. Fresh instance construction in `beforeEach` — rather than sharing a service instance across tests, a new one is constructed each time, so any in-memory state (like a failure counter in a circuit breaker) resets between tests.

The `jest.clearAllMocks()` call appears in every test suite in this project — it is the single most important hygiene habit.

---

### 1.4 Supertest: HTTP Testing Without a Real Server

`supertest` is a Node.js library that wraps a Node HTTP server (or a Koa/Express app's `callback()`) and allows you to make programmatic HTTP requests against it without binding to a real TCP port.

Without supertest you would have to:

1. Start the server on a port.
2. Make real network requests to `http://localhost:<port>/...`.
3. Tear down the server after the test.

This approach has problems: port conflicts in CI, timing issues around startup, and test isolation becoming port-level rather than process-level.

With supertest:

```typescript
// Pseudocode: how supertest works
import request from 'supertest';
import { createApp } from './app';

const app = createApp(); // builds the Koa app, does not start listening

const res = await request(app.callback())  // wraps the Koa callback as an HTTP handler
  .post('/api/v1/auth/login')
  .send({ email: 'alice@example.com', password: 'pass' });

expect(res.status).toBe(200);
```

`app.callback()` returns a standard Node `(req, res) => void` handler. Supertest creates a temporary in-process HTTP server for the duration of the request. No port binding, no network overhead, no timing issues.

---

### 1.5 Jest: The Test Framework

Jest is a test runner, assertion library, and mocking framework bundled together. Key constructs:

**`describe(name, fn)`** — Groups related tests. Describes can be nested. The nesting shows up in the test output.

**`it(name, fn)` / `test(name, fn)`** — Defines a single test case. `it` and `test` are aliases.

**`beforeAll(fn)`** — Runs once before all tests in the enclosing `describe` block.

**`beforeEach(fn)`** — Runs before every test in the enclosing `describe` block. The right place for per-test reset logic.

**`afterAll(fn)`** — Runs once after all tests. The right place for resource teardown (closing DB connections, stopping servers).

**`expect(value)`** — The entry point for assertions. Chained with matchers:

- `.toBe(x)` — strict reference equality (`===`)
- `.toEqual(x)` — deep value equality
- `.toMatchObject(x)` — asserts the received object contains at least the keys in `x` (extra keys are allowed)
- `.toHaveBeenCalledWith(...)` — asserts a `jest.fn()` was called with specific arguments
- `.rejects.toThrow(Error)` — asserts an async function throws

**`jest.fn()`** — Creates a mock function. You set its return value with `.mockResolvedValue(x)` (for Promises) or `.mockReturnValue(x)` (for sync). You inspect calls via `.mock.calls`, `.mock.results`, and matchers.

**`jest.mock(modulePath, factory)`** — Replaces an entire module with a factory-produced substitute. Crucially, Jest hoists this call to the top of the compiled output, before any `import` statements execute. This is what makes module-level mocking work with ES modules compiled by TypeScript.

---

### 1.6 Test Behaviour, Not Implementation

The rule "test behaviour, not implementation" means: assert on what a unit does for its callers, not how it does it internally.

**Anti-pattern — testing internal state:**

```typescript
// Bad: reaches inside the service to inspect private state
it('stores the user in internal cache', async () => {
  await service.register('alice@example.com', 'Alice', 'pass');
  expect((service as any)._internalUserCache.size).toBe(1); // accesses private field
});
```

This test will break the moment you rename `_internalUserCache` or switch to a Map, even if the external behaviour is unchanged. The test is coupled to the implementation, not the contract.

**Correct approach — testing observable behaviour:**

```typescript
// Good: asserts what the caller receives and which collaborators were invoked
it('returns the created user without a passwordHash field', async () => {
  const result = await service.register('alice@example.com', 'Alice', 'pass');
  expect(result.email).toBe('alice@example.com');
  expect(result).not.toHaveProperty('passwordHash'); // caller must never see the hash
});
```

The observable behaviours for a service are: what it returns, what errors it throws, and which collaborator methods it called (and with what arguments). Anything else is an implementation detail.

---

### 1.7 Module-Level Mock Hoisting

Jest's `jest.mock()` calls are hoisted by Babel/`ts-jest` to the very top of the compiled module, before any `import` or `require` executes. This is not just a convention — it is enforced by the compiler transform.

Consider:

```typescript
// What you write:
import { AuthService } from '../src/modules/auth/AuthService';
jest.mock('../src/config/database', () => ({ AppDataSource: { getRepository: jest.fn() } }));
```

```typescript
// What ts-jest compiles it to (conceptually):
jest.mock('../src/config/database', () => ({ AppDataSource: { getRepository: jest.fn() } }));
// ↑ moved to top

const AuthService_1 = require('../src/modules/auth/AuthService');
// ↑ AuthService's own require of database now gets the mock
```

The implication is: any module that `AuthService` imports at load time — including `database` — is already mocked by the time `AuthService` is evaluated. This is why the pattern works. If you put the `jest.mock()` call after the `import`, the real module has already loaded and the mock has no effect.

This is also why mock variables captured with `jest.fn()` (like `const mockRegister = jest.fn()`) must be declared **before** the `jest.mock()` factory that references them. Factories cannot close over variables that are declared after the hoist point. The one exception: variables named with a `mock` prefix are allowed by Jest's hoist transform.

---

## Part 2 — Implementation Walkthrough

### 2.1 jest.config.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/jest.config.ts`

```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^p-limit$': '<rootDir>/tests/__mocks__/p-limit.js',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/migrations/**', '!src/seeds/**'],
};
export default config;
```

**`preset: 'ts-jest'`** — Tells Jest to use `ts-jest` as the transform. `ts-jest` compiles every `.ts` test file through the TypeScript compiler before Jest runs it. This means your tests are type-checked and you get compile-time errors for wrong mock shapes.

**`testEnvironment: 'node'`** — Specifies the environment in which tests run. `node` gives you a real Node.js global scope. The alternative, `jsdom`, simulates a browser DOM and is only relevant for frontend tests. Using `node` keeps the environment honest for a server-side codebase.

**`rootDir: '.'`** — The base directory for resolving relative paths in the config. Setting it to the project root means all `<rootDir>/...` placeholders resolve relative to the repo root.

**`testMatch: ['<rootDir>/tests/**/*.test.ts']`** — The glob pattern Jest uses to discover test files. Only files ending in `.test.ts` under the `tests/` directory are collected. This prevents Jest from accidentally running non-test TypeScript files.

**`moduleNameMapper`** — Rewrites module specifiers before resolution. There are two entries:

- `'^@/(.*)$': '<rootDir>/src/$1'` — Maps the `@/` path alias (configured in `tsconfig.json`) to `src/`. So `import { foo } from '@/utils/foo'` resolves to `src/utils/foo.ts` in tests.
- `'^p-limit$': '<rootDir>/tests/__mocks__/p-limit.js'` — Replaces the real `p-limit` package with a CJS-compatible stub. `p-limit` v6 is a pure-ESM package; Node's CommonJS module system (used by `ts-jest` in its default transform mode) cannot `require()` it directly. The stub, shown below, sidesteps the compatibility issue entirely:

```javascript
// tests/__mocks__/p-limit.js
const pLimit = (_concurrency) => {
  return (fn) => fn();
};
module.exports = pLimit;
module.exports.default = pLimit;
```

In tests, concurrency limiting is not needed, so the stub just calls the function immediately with no queuing.

**`setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']`** — Runs `setup.ts` once per test **suite** (once per file), after the test framework has been installed but before any tests run. This is the right place for global `beforeAll`/`afterAll` hooks.

**`coverageDirectory: 'coverage'`** — Where the HTML and JSON coverage reports are written when you run `jest --coverage`.

**`collectCoverageFrom: ['src/**/*.ts', '!src/migrations/**', '!src/seeds/**']`** — The set of source files to include in the coverage report. Migration files and seed files are excluded because they are not application logic that benefits from test coverage measurement.

---

### 2.2 tests/setup.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/setup.ts`

```typescript
// Global test lifecycle hooks — DB init, truncation, Redis flush go here (see T23).
```

The current file is intentionally minimal — it contains the scaffolding comment for future global hooks. In a project that uses a real test database, this file would contain:

- A `beforeAll` that runs migrations against a test database schema
- An `afterEach` that truncates all tables (restoring a clean state between tests)
- An `afterAll` that closes the database connection pool

Because this project's tests use module-level mocks for all infrastructure, no real connections are established and these lifecycle hooks are not yet needed. The file exists so that when they are needed, there is an established location.

---

### 2.3 The Mock Strategy: Why Everything Is Mocked

Looking across all test files, four infrastructure modules are consistently mocked at the top of every test suite:

```
src/config/database    → AppDataSource (TypeORM)
src/config/redis       → redis, redisSub (ioredis clients)
src/config/env         → env (validated config object)
src/infrastructure/logger/Logger → logger
```

The reason for mocking all four:

**Database (`AppDataSource`)** — TypeORM's `initialize()` opens a real MySQL connection pool. Even with a localhost test database, this adds 200–500ms of startup time per suite and requires the database to be running. More importantly, tests that modify the database become order-dependent. By mocking `getRepository` and `transaction`, tests verify the application's logic without any I/O.

**Redis** — ioredis connects to a real Redis server on import if the connection is not mocked. A disconnected Redis causes all tests to fail with `ECONNREFUSED`. Mocking the Redis client means the test suite is self-contained and can run anywhere, including in CI containers that do not have Redis.

**Environment config (`env`)** — The `env` module validates environment variables at import time using zod or a similar library. If `process.env.JWT_SECRET` is not set, the import throws, crashing the test suite before a single test runs. By replacing the module with a hardcoded object, tests are independent of the execution environment.

**Logger** — The logger writes to `stdout`/`stderr`. In a test suite that runs hundreds of tests, this produces enormous noise in CI output. Mocking it to no-ops silences the logs. Some tests also assert that the logger was called with specific messages, which requires it to be a `jest.fn()`.

---

### 2.4 Integration Test Walkthrough: authApi.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/integration/authApi.test.ts`

This test verifies the HTTP layer for auth routes. It is an integration test, not a unit test, because it exercises the real Koa middleware pipeline: the auth router, the request body validator, the JWT verifier, and the error serializer all run for real. Only the service layer and infrastructure are mocked.

#### Mock Setup

The file begins with eight `jest.mock()` calls before any `import`:

```typescript
// 1. Hardcoded config so env validation never throws
jest.mock('../../src/config/env', () => ({ env: { JWT_SECRET: '...', ... } }));

// 2. AppDataSource — not needed for auth routes, but imported transitively
jest.mock('../../src/config/database', () => ({
  AppDataSource: { getRepository: jest.fn(), initialize: jest.fn().mockResolvedValue(undefined) },
}));

// 3. Redis — auth middleware checks token revocation with redis.exists()
jest.mock('../../src/config/redis', () => ({
  redis: { exists: jest.fn().mockResolvedValue(0), ... },
  redisSub: { on: jest.fn() },
}));

// 4. Logger — silence logs
jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 5. The AuthManager itself — the class under the controller
const mockRegister = jest.fn();
const mockLogin    = jest.fn();
const mockLogout   = jest.fn();

jest.mock('../../src/modules/auth/AuthManager', () => ({
  AuthManager: jest.fn().mockImplementation(() => ({
    register: mockRegister,
    login:    mockLogin,
    logout:   mockLogout,
  })),
}));
```

Notice that `AuthManager` is mocked as a class (`jest.fn().mockImplementation(() => ...)`) because the route handler calls `new AuthManager(...)`. The mock intercepts the constructor call and returns a plain object with the three mock methods.

#### The App Instance

```typescript
describe('Auth API — /api/v1/auth', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });
```

`createApp()` is called once for the entire suite. It constructs the Koa application, registers all middleware and routers, and returns the app object — without calling `app.listen()`. There is no port, no socket, no server process. Supertest will wrap this app for individual test requests.

The app is created in `beforeAll` (once per suite) rather than `beforeEach` (once per test) because constructing the app is moderately expensive and the app itself has no mutable state — it is stateless between requests.

#### Individual Test

```typescript
it('1. valid body → 201 + { data: user }', async () => {
  mockRegister.mockResolvedValue(VALID_USER);

  const res = await request(app.callback())
    .post('/api/v1/auth/register')
    .send({ email: 'alice@example.com', password: 'password123', displayName: 'Alice Tester' });

  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('data');
  expect(res.body.data).toMatchObject({ email: 'alice@example.com', displayName: 'Alice Tester' });
  expect(mockRegister).toHaveBeenCalledWith('alice@example.com', 'Alice Tester', 'password123');
});
```

Step by step:
1. `mockRegister.mockResolvedValue(VALID_USER)` — programs the mock so that when the route handler calls `authManager.register(...)`, it returns `VALID_USER`.
2. `request(app.callback())` — supertest wraps the Koa callback.
3. `.post('/api/v1/auth/register').send(...)` — builds and dispatches an HTTP POST request.
4. `expect(res.status).toBe(201)` — asserts the response status.
5. `expect(res.body).toHaveProperty('data')` — asserts the response JSON envelope structure.
6. `expect(mockRegister).toHaveBeenCalledWith(...)` — asserts the controller passed the right arguments to the manager, in the right order.

The last assertion is important: it verifies that the controller correctly parsed the request body and passed `email`, `displayName`, and `password` in the right order. If the route handler accidentally swapped `email` and `displayName`, this assertion would catch it.

#### Testing Validation Without the Service Layer

```typescript
it('4. short password (< 8 chars) → 400 validation error', async () => {
  const res = await request(app.callback())
    .post('/api/v1/auth/register')
    .send({ email: 'alice@example.com', password: 'short', displayName: 'Alice Tester' });

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(res.body.error.details).toHaveProperty('fields');
  expect(mockRegister).not.toHaveBeenCalled();
});
```

This test verifies that the input validation middleware (zod schema, Joi schema, or similar) rejects invalid input before the request reaches the service layer. The assertion `expect(mockRegister).not.toHaveBeenCalled()` is the critical piece: it proves that the validation layer acted as a guard and that no business logic was invoked on bad input.

#### Testing Token Revocation

```typescript
it('10. revoked token → 401 Unauthorized', async () => {
  const { redis } = jest.requireMock('../../src/config/redis');
  redis.exists.mockResolvedValueOnce(1); // simulate revoked jti

  const token = makeToken();
  const res = await request(app.callback())
    .post('/api/v1/auth/logout')
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(401);
  expect(mockLogout).not.toHaveBeenCalled();
});
```

`jest.requireMock()` fetches the mock instance that was registered by `jest.mock()`. This lets a specific test override the default mock behaviour (`exists` normally returns `0` meaning "not revoked") to simulate `1` (revoked). `mockResolvedValueOnce(1)` applies only to the next call and then reverts to the default — so this test's revocation scenario does not bleed into subsequent tests.

---

### 2.5 Data Flow Through an Integration Test

```
Test                  Supertest              Koa App
────                  ─────────              ────────
request(app.callback())
  .post('/api/v1/auth/register')
  .send({ email, password, displayName })
         │
         ▼
  [in-process HTTP server]
         │
         ▼
  Koa middleware pipeline:
    1. Error handler middleware
    2. Request logger middleware
    3. Rate limiter middleware  ← calls redis.zcard (mocked → 0)
    4. Auth router
       └── POST /register
           ├── Validation middleware ← rejects bad input with 400
           └── Controller
               └── authManager.register(...)  ← calls mock → returns VALID_USER
                   └── ctx.body = { data: VALID_USER }; ctx.status = 201
         │
         ▼
  res.status = 201
  res.body   = { data: { email, displayName, ... } }
         │
         ▼
  Test assertions
```

---

### 2.6 Unit Test Walkthrough: AuthService.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/modules/auth/AuthService.test.ts`

This test is a pure unit test. `AuthService` is instantiated with a mocked `UserRepository`, and all external libraries (`bcryptjs`, `jsonwebtoken`, `ioredis`) are mocked at module level. No Koa, no HTTP, no supertest.

#### The Repository Mock Factory

```typescript
function makeRepoMock(): jest.Mocked<UserRepository> {
  return {
    findByEmail: jest.fn(),
    findById:    jest.fn(),
    save:        jest.fn(),
  } as unknown as jest.Mocked<UserRepository>;
}
```

Using a factory function rather than a module-level variable is important: each test gets a fresh `jest.Mocked<UserRepository>` constructed in `beforeEach`, so no call history bleeds between tests even if `jest.clearAllMocks()` were somehow missed.

The `jest.Mocked<T>` generic type from Jest wraps every method of `T` as a `jest.Mock`, giving TypeScript autocomplete for `.mockResolvedValue(...)` while still passing the type checks of the production code.

#### Testing the Register Happy Path

```typescript
it('happy path — saves user with hashed password and returns user without passwordHash', async () => {
  const hashedPw = 'bcrypt_hashed_value';
  const savedUser = makeUser({ passwordHash: hashedPw });

  repo.findByEmail.mockResolvedValue(null);     // email not taken
  mockBcryptHash.mockResolvedValue(hashedPw);   // bcrypt returns predictable hash
  repo.save.mockResolvedValue(savedUser);        // DB returns saved entity

  const result = await service.register('alice@example.com', 'Alice', 'plain_password');

  // 1. bcrypt was called with the raw password and correct rounds
  expect(mockBcryptHash).toHaveBeenCalledWith('plain_password', 12);

  // 2. save was called with the hash, never the raw password
  expect(repo.save).toHaveBeenCalledWith(
    expect.objectContaining({ passwordHash: hashedPw }),
  );
  expect(repo.save).not.toHaveBeenCalledWith(
    expect.objectContaining({ password: expect.anything() }),
  );

  // 3. the returned object must not expose the hash to callers
  expect(result).not.toHaveProperty('passwordHash');
  expect(result.email).toBe('alice@example.com');
});
```

Assertion 2 uses `expect.objectContaining(...)` — a partial matcher that allows extra keys. This is the right choice: you care that `passwordHash` is present and correct, not that no other fields were included.

Assertion 3 is a security test: the caller of `register` must never receive the password hash. If the service forgets to strip it before returning, this assertion fails.

#### Testing the Logout Redis TTL Calculation

```typescript
it('blacklists jti in Redis with TTL equal to remaining token lifetime', async () => {
  const now = Math.floor(Date.now() / 1000);
  const jti = 'test-jti-uuid-abc';
  const exp = now + 300;  // token expires in 5 minutes

  mockRedisSetex.mockResolvedValue('OK');

  await service.logout(jti, exp);

  expect(mockRedisSetex).toHaveBeenCalledTimes(1);
  const [key, ttl, value] = mockRedisSetex.mock.calls[0];
  expect(key).toContain(jti);
  expect(ttl).toBeGreaterThanOrEqual(1);
  expect(ttl).toBeLessThanOrEqual(300);
  expect(value).toBe('1');
});
```

This test accesses `mockRedisSetex.mock.calls[0]` directly to destructure the arguments Redis was called with. `mock.calls` is an array of arrays — each entry is the full argument list of one call. This is the most precise way to assert on the exact key and TTL that were used, without relying on string formatting or serialisation in `toHaveBeenCalledWith`.

The TTL range assertion (`toBeGreaterThanOrEqual(1)` and `toLessThanOrEqual(300)`) is correct here because the test cannot know the exact millisecond at which `Date.now()` is called inside the service. Asserting an exact value would make the test timing-dependent.

---

### 2.7 Unit Test Walkthrough: IssueQueryService.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/modules/issues/IssueQueryService.test.ts`

This test is notable for two things: mocking a TypeORM query builder fluent chain, and testing a multi-layer cache interaction.

#### Mocking the QueryBuilder Fluent Chain

TypeORM's query builder uses method chaining:

```typescript
repo.createQueryBuilder('i')
  .leftJoinAndSelect('i.status', 'status')
  .where('i.projectId = :projectId', { projectId })
  .andWhere('i.sprintId = :sprintId', { sprintId })
  .orderBy('i.createdAt', 'DESC')
  .getMany();
```

Each method returns `this`. To mock this, every chained method must return the mock object itself:

```typescript
const mockQueryBuilder = {
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where:             jest.fn().mockReturnThis(),
  andWhere:          jest.fn().mockReturnThis(),
  select:            jest.fn().mockReturnThis(),
  orderBy:           jest.fn().mockReturnThis(),
  addOrderBy:        jest.fn().mockReturnThis(),
  limit:             jest.fn().mockReturnThis(),
  getMany:           mockGetMany,  // ← this is the terminal call we vary per test
};
```

`.mockReturnThis()` is a Jest helper that programs `jest.fn()` to return the calling context (`this`) — exactly what TypeORM's real methods do. Only `getMany` is a real `jest.fn()` without `mockReturnThis()` because it is the terminal call that returns data.

The `resetAllMocks()` helper (called in `beforeEach`) must re-apply `.mockReturnThis()` after `mockClear()` because `mockClear` resets the implementation:

```typescript
function resetAllMocks() {
  mockQueryBuilder.leftJoinAndSelect.mockClear();
  // mockClear removes the implementation, so we must restore it:
  mockQueryBuilder.leftJoinAndSelect.mockReturnThis();
  // ... same for all other chained methods
}
```

#### Testing the Cache-DB Interaction

```typescript
describe('cache hit', () => {
  it('returns the cached BoardView immediately without hitting the DB', async () => {
    const cachedBoard: BoardView = { projectId: PROJECT_ID, sprintId: SPRINT_ID, ... };
    mockRedisCacheGet.mockResolvedValue(cachedBoard);

    const result = await service.getBoardView(PROJECT_ID, SPRINT_ID);

    expect(result).toBe(cachedBoard);
    expect(mockGetRepository).not.toHaveBeenCalled();  // DB must NOT be touched
  });
});
```

The assertion `expect(result).toBe(cachedBoard)` uses `toBe` (reference equality) rather than `toEqual` (deep equality). This is intentional: if the service returns the same object reference from the cache (not a copy), `toBe` will pass. If the service deserialises and re-serialises the value, `toBe` would fail and signal that the cache hit path is doing unnecessary work.

The paired assertion `expect(mockGetRepository).not.toHaveBeenCalled()` is the behaviour being tested: on a cache hit, the database must not be queried at all.

---

### 2.8 Concurrency Test Walkthrough: concurrentUpdates.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/integration/concurrentUpdates.test.ts`

This test verifies that TypeORM's optimistic locking protection is correctly propagated through `IssueCommandService`.

Optimistic locking works by attaching a `version` number to each entity. When two callers both read version 1 and attempt to save, the first save increments the version to 2. The second save, which still carries version 1, causes the database to throw `OptimisticLockVersionMismatchError` because the row has changed.

In a real system with a real database, you would need to set up two concurrent database connections and a synchronization barrier. In tests, you simulate the entire scenario by programming the mocked transaction:

```typescript
it('returns the updated issue for the first caller and throws ConflictError (409) for the second', async () => {
  const lockError = new Error('Version mismatch');
  lockError.name  = 'OptimisticLockVersionMismatchError';

  mockTransaction
    .mockResolvedValueOnce(updatedIssue) // first caller wins — transaction succeeds
    .mockRejectedValueOnce(lockError);   // second caller loses — TypeORM throws

  const [result1, result2] = await Promise.allSettled([
    service.update('issue-001', { title: 'Updated title', version: 1 }, 'user-001', 'corr-001'),
    service.update('issue-001', { title: 'Updated title', version: 1 }, 'user-002', 'corr-002'),
  ]);

  // First call: fulfilled
  expect(result1.status).toBe('fulfilled');
  if (result1.status === 'fulfilled') {
    expect(result1.value).toEqual(updatedIssue);
  }

  // Second call: rejected with a ConflictError (HTTP 409)
  expect(result2.status).toBe('rejected');
  if (result2.status === 'rejected') {
    const err = result2.reason as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/modified by another user/i);
  }
});
```

`Promise.allSettled()` is the right tool here: unlike `Promise.all()`, it does not short-circuit on the first rejection. It waits for both promises to settle and returns an array of `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }` descriptors.

What this test actually verifies is the **error translation layer** in `IssueCommandService`: when TypeORM throws `OptimisticLockVersionMismatchError`, the service must translate it to a `ConflictError` with `statusCode: 409` and a user-readable message. The test proves this translation works correctly and that the error is not swallowed or re-thrown as an untyped 500.

The companion test:

```typescript
it('re-throws non-optimistic-lock errors from the transaction unchanged', async () => {
  const dbError = new Error('Unexpected DB failure');
  mockTransaction.mockRejectedValueOnce(dbError);

  await expect(
    service.update('issue-001', { title: 'x', version: 1 }, 'user-001', 'corr-001'),
  ).rejects.toThrow('Unexpected DB failure');
});
```

This verifies that the error translation code is selective: it translates only `OptimisticLockVersionMismatchError`. Any other database error must propagate unchanged so that it surfaces as an unhandled exception (HTTP 500) rather than being misclassified as a client conflict.

---

### 2.9 Circuit Breaker Test Walkthrough: circuitBreaker.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/integration/circuitBreaker.test.ts`

The circuit breaker implements a finite state machine with four states: `CLOSED` (normal), `OPEN` (failing fast), `HALF_OPEN` (probing for recovery), and `CLOSED` (recovered). Redis is used as the backing store for the `OPEN`/`HALF_OPEN` flags so the state survives process restarts.

Testing a state machine requires controlling its current state and observing transitions. The Redis mock makes this straightforward:

```typescript
// Control: "pretend Redis says the circuit is OPEN"
redisMock.get.mockResolvedValue('OPEN');

// Observe: "when we attempt a call, the function must not be invoked"
it('throws immediately without invoking the function when circuit is OPEN', async () => {
  const cb  = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
  const fn  = jest.fn(() => Promise.resolve('should not run'));

  await expect(cb.execute(fn)).rejects.toThrow(`Circuit breaker '${CB_NAME}' is OPEN`);
  expect(fn).not.toHaveBeenCalled();
});
```

The test structure maps directly to the state machine:

```
CLOSED state tests:
  - fn executes and returns result ✓
  - failures below threshold do not trigger setex ✓

OPEN transition tests:
  - setex called with 'OPEN' after reaching threshold ✓
  - setex called exactly once (not on every failure) ✓

OPEN state tests:
  - fn not invoked when state is OPEN ✓
  - no additional setex calls when already OPEN ✓

HALF_OPEN state tests:
  - successful probe causes del (deletes the OPEN key → CLOSED) ✓
```

The `HALF_OPEN` test is particularly instructive:

```typescript
describe('HALF_OPEN state', () => {
  it('resets to CLOSED (calls redis.del) on a successful execution from HALF_OPEN', async () => {
    redisMock.get.mockResolvedValue('HALF_OPEN');

    const cb = new CircuitBreaker(CB_NAME, THRESHOLD, TIMEOUT_SECS);
    await cb.execute(() => Promise.resolve('probe ok'));

    expect(redisMock.del).toHaveBeenCalledWith(CacheKeys.circuitBreaker(CB_NAME));
  });
});
```

The `HALF_OPEN → CLOSED` transition is represented by deleting the Redis key (so the next `GET` returns `null`, meaning `CLOSED`). The test asserts that `redis.del` was called with the exact key generated by `CacheKeys.circuitBreaker(CB_NAME)`. This tests both the state transition logic and the correctness of the cache key generation.

---

### 2.10 Unit Test Walkthrough: IssueIndexCache.test.ts

**File:** `/Users/alokprasad/Documents/workspace/product-management-platform/tests/unit/cache/IssueIndexCache.test.ts`

This test shows how to unit test Redis pipeline operations. A pipeline queues multiple commands and sends them in a single round trip:

```typescript
redis.pipeline()
  .zadd(key1, score, id)
  .zadd(key2, score, id)
  .expire(key1, ttl)
  .exec()
```

To mock this, the stub must implement the builder pattern — each method returns `this` so the chain resolves — and the terminal `.exec()` must return a Promise:

```typescript
const pipelineStub = {
  zadd:   jest.fn().mockReturnThis(),
  zrem:   jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec:   mockExec,  // returns Promise.resolve([])
};

mockPipeline.mockReturnValue(pipelineStub);

jest.mock('../../../src/config/redis', () => ({
  redis: {
    pipeline: mockPipeline,
    exists:   mockExists,
    zrevrange: mockZrevrange,
    // ...
  },
}));
```

The `populateFromIssues` test demonstrates counting pipeline calls:

```typescript
it('pipelines ZADD for each issue and sets expire on sprint key', async () => {
  const issues = [
    { id: 'i1', createdAt: new Date('2025-01-01'), statusId: STATUS_ID },
    { id: 'i2', createdAt: new Date('2025-01-02'), statusId: STATUS_ID_2 },
  ] as any[];

  await cache.populateFromIssues(PROJECT_ID, SPRINT_ID, issues);

  expect(pipelineStub.zadd).toHaveBeenCalledTimes(4); // 2 sprint + 2 status
  expect(pipelineStub.expire).toHaveBeenCalledWith(
    CacheKeys.sprintIssueIndex(PROJECT_ID, SPRINT_ID),
    expect.any(Number),
  );
  expect(mockExec).toHaveBeenCalled();
});
```

The assertion `toHaveBeenCalledTimes(4)` is a counting assertion: for two issues, you expect two sprint-index `zadd` calls and two status-index `zadd` calls. If the implementation adds an extra `zadd` or forgets one, this catches it.

---

### 2.11 Naming Conventions and Directory Layout

```
tests/
├── __mocks__/
│   └── p-limit.js              ← manual module mock for ESM-incompatible packages
├── setup.ts                    ← global lifecycle hooks (beforeAll/afterAll)
├── integration/
│   ├── authApi.test.ts         ← route-level tests (HTTP + middleware)
│   ├── issuesApi.test.ts
│   ├── sprintApi.test.ts
│   ├── concurrentUpdates.test.ts ← cross-cutting concerns (locking, concurrency)
│   └── circuitBreaker.test.ts
├── modules/
│   ├── auth/
│   │   └── AuthService.test.ts ← service-layer unit tests, co-located by module
│   ├── issues/
│   │   └── IssueQueryService.test.ts
│   └── sprints/
│       └── SprintService.test.ts
└── unit/
    └── cache/
        ├── MembershipCache.test.ts ← infrastructure unit tests
        └── IssueIndexCache.test.ts
```

**Conventions:**

- Test files are always named `<ClassName>.test.ts` or `<domain>.test.ts`.
- Unit tests for a service live under `tests/modules/<module-name>/`.
- Integration tests that exercise HTTP routes live under `tests/integration/`.
- Unit tests for infrastructure classes (caches, utilities) live under `tests/unit/<subsystem>/`.
- Manual module mocks live under `tests/__mocks__/` and must be referenced in `moduleNameMapper` in `jest.config.ts`.

---

### 2.12 How to Add a Test for a New Module

Suppose you are adding a `CommentService` to a `comments` module. Here is the pattern:

**Step 1** — Create the file `tests/modules/comments/CommentService.test.ts`.

**Step 2** — Add all module-level mocks before any imports:

```typescript
// tests/modules/comments/CommentService.test.ts

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'supersecretkey_that_is_at_least_32chars',
    // ... other required fields
  },
}));

jest.mock('../../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn() },
}));

jest.mock('../../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
```

**Step 3** — Import the real module under test after the mocks:

```typescript
import { CommentService } from '../../../src/modules/comments/CommentService';
import { CommentRepository } from '../../../src/modules/comments/CommentRepository';
import { NotFoundError } from '../../../src/core/errors/errors';
```

**Step 4** — Create a fixture factory for your domain entity:

```typescript
function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id:        'comment-1',
    issueId:   'issue-1',
    authorId:  'user-1',
    body:      'Test comment',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  } as Comment;
}
```

**Step 5** — Create a typed mock for the repository:

```typescript
function makeRepoMock(): jest.Mocked<CommentRepository> {
  return {
    findById:       jest.fn(),
    findByIssue:    jest.fn(),
    save:           jest.fn(),
    softDelete:     jest.fn(),
  } as unknown as jest.Mocked<CommentRepository>;
}
```

**Step 6** — Write the test suite:

```typescript
describe('CommentService', () => {
  let repo: jest.Mocked<CommentRepository>;
  let service: CommentService;

  beforeEach(() => {
    jest.clearAllMocks();
    repo    = makeRepoMock();
    service = new CommentService(repo);
  });

  describe('create', () => {
    it('saves comment and returns it', async () => {
      const comment = makeComment();
      repo.save.mockResolvedValue(comment);

      const result = await service.create('issue-1', 'user-1', 'Test comment');

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: 'issue-1', body: 'Test comment' }),
      );
      expect(result.body).toBe('Test comment');
    });

    it('throws NotFoundError when issue does not exist', async () => {
      // depends on whether CommentService checks for the issue first
    });
  });
});
```

The critical checklist before declaring a test complete:
- All infrastructure mocks are declared before imports.
- `jest.clearAllMocks()` is called in `beforeEach`.
- The service is constructed fresh in `beforeEach`.
- Happy path and at least one error path are tested.
- Where the service calls a collaborator, there is an assertion on what it was called with.
- Where the service returns a value, there is an assertion on what was returned.
- Where the service must NOT call a collaborator (e.g., after validation failure), there is a `not.toHaveBeenCalled()` assertion.

---

## Key Takeaways

- The testing pyramid is a cost model: unit tests are cheap and fast, E2E tests are expensive and slow. Write more of the cheap ones and fewer of the expensive ones. This project's suite is almost entirely unit and integration tests by design.
- `jest.mock()` calls are hoisted before imports by `ts-jest`. This is not optional — it is the mechanism that makes module-level mocking work. All infrastructure mocks must appear before any `import` statement in every test file.
- Test isolation requires both `jest.clearAllMocks()` in `beforeEach` and fresh object construction in `beforeEach`. One without the other leaves the door open for state leakage between tests.
- Supertest eliminates the need for a real listening server. `request(app.callback())` gives you a full HTTP request/response cycle in-process, with no ports, no network latency, and no timing issues.
- Mock only what you must: in integration tests, mock infrastructure (DB, Redis, SQS) but let the real Koa middleware pipeline run. In unit tests, mock all collaborators. This distinction is what separates "integration test" from "unit test" in this codebase.
- Test behaviour, not implementation. Assert on what is returned, what errors are thrown, and which collaborator methods were called. Never assert on private fields or internal data structures.
- The `not.toHaveBeenCalled()` assertion is as important as `toHaveBeenCalledWith()`. It proves that guard logic (validation, auth, RBAC) prevents downstream code from executing on bad input — a common source of security bugs when omitted.
- Optimistic locking and circuit breaker state machines can be fully tested without real infrastructure by programming the mock transaction or mock Redis `get` to return the values that represent each state. This makes concurrency and resilience tests deterministic and fast.

---

## Further Reading

- **"The Practical Test Pyramid"** by Ham Vocke (martinfowler.com) — the canonical modern explanation of the pyramid model and how it applies to microservices.
- **"Working Effectively with Legacy Code"** by Michael Feathers (Prentice Hall, 2004) — the foundational text on seam-based testing, mock strategies, and how to make untestable code testable.
- **"Growing Object-Oriented Software, Guided by Tests"** by Steve Freeman and Nat Pryce (Addison-Wesley, 2009) — explains mock-based testing from first principles, including the distinction between mocks and stubs and the "tell, don't ask" principle.
- **Jest documentation: Mock Functions** (jestjs.io/docs/mock-functions) — the official reference for `jest.fn()`, `jest.mock()`, `jest.spyOn()`, and all matchers related to mock call assertions.
- **Supertest repository README** (github.com/ladjs/supertest) — concise API reference for `request(app)`, `.set()`, `.send()`, and response assertions, including how to handle cookies and multipart forms.
