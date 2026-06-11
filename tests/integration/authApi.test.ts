/**
 * Route-level integration tests for POST /api/v1/auth/register and POST /api/v1/auth/login.
 *
 * The AuthManager (and its internals) is mocked at module level — no real DB or Redis needed.
 * Infrastructure modules (database, redis, logger, metrics) are also stubbed out so the
 * Koa app factory can be imported without live connections.
 */

// ── Module-level mocks (hoisted by Jest before any import) ────────────────────

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 3000,
    JWT_SECRET: 'supersecretkey_that_is_at_least_32chars!!',
    JWT_EXPIRES_IN: '7d',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_NAME: 'testdb',
    DB_USER: 'user',
    DB_PASSWORD: 'pass',
    DB_POOL_MAX: 5,
    REDIS_URL: 'redis://localhost:6379',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_NOTIFICATION_QUEUE_URL: 'http://localhost/queue',
    LOG_LEVEL: 'silent',
  },
}));

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn(),
    initialize:    jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/config/redis', () => ({
  redis:    { exists: jest.fn().mockResolvedValue(0), zremrangebyscore: jest.fn().mockResolvedValue(0), zcard: jest.fn().mockResolvedValue(0), zadd: jest.fn().mockResolvedValue(0), expire: jest.fn().mockResolvedValue(0) },
  redisSub: { on: jest.fn() },
}));

jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock the manager so no real bcrypt/DB work happens
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

// SQS / notification bus referenced transitively
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient:        jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'supersecretkey_that_is_at_least_32chars!!';

function makeToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: 'user-uuid-1', email: 'alice@example.com', jti: 'test-jti-123', ...overrides },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

const VALID_USER = {
  id:          'user-uuid-1',
  email:       'alice@example.com',
  displayName: 'Alice Tester',
  createdAt:   new Date('2024-01-01').toISOString(),
  updatedAt:   new Date('2024-01-01').toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth API — /api/v1/auth', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── POST /register ──────────────────────────────────────────────────────────

  describe('POST /api/v1/auth/register', () => {
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

    it('2. missing email → 400 validation error', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/register')
        .send({ password: 'password123', displayName: 'Alice Tester' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('3. missing password → 400 validation error', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/register')
        .send({ email: 'alice@example.com', displayName: 'Alice Tester' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('4. short password (< 8 chars) → 400 validation error', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/register')
        .send({ email: 'alice@example.com', password: 'short', displayName: 'Alice Tester' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toHaveProperty('fields');
      expect(mockRegister).not.toHaveBeenCalled();
    });
  });

  // ── POST /login ─────────────────────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    it('5. valid credentials → 200 + { data: { accessToken, user } }', async () => {
      mockLogin.mockResolvedValue({ accessToken: 'signed.jwt.token', user: VALID_USER });

      const res = await request(app.callback())
        .post('/api/v1/auth/login')
        .send({ email: 'alice@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('accessToken', 'signed.jwt.token');
      expect(res.body.data).toHaveProperty('user');
      expect(mockLogin).toHaveBeenCalledWith('alice@example.com', 'password123');
    });

    it('6. missing body (no email or password) → 400 validation error', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockLogin).not.toHaveBeenCalled();
    });
  });

  // ── POST /logout ────────────────────────────────────────────────────────────

  describe('POST /api/v1/auth/logout', () => {
    it('7. valid Bearer token → 204 No Content and calls manager.logout', async () => {
      mockLogout.mockResolvedValue(undefined);
      const token = makeToken();

      const res = await request(app.callback())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
      expect(mockLogout).toHaveBeenCalledWith('test-jti-123', expect.any(Number));
    });

    it('8. no Authorization header → 401 Unauthorized', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/logout');

      expect(res.status).toBe(401);
      expect(mockLogout).not.toHaveBeenCalled();
    });

    it('9. malformed/invalid token → 401 Unauthorized', async () => {
      const res = await request(app.callback())
        .post('/api/v1/auth/logout')
        .set('Authorization', 'Bearer not.a.valid.token');

      expect(res.status).toBe(401);
      expect(mockLogout).not.toHaveBeenCalled();
    });

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
  });
});
