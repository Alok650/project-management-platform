/**
 * Route-level integration tests for issue endpoints under /api/v1.
 *
 * Auth middleware is exercised with a real JWT signed using the test secret.
 * RBAC (requireProjectRole) is tested by controlling what AppDataSource.getRepository
 * returns for ProjectMember lookups.
 * IssueManager is fully mocked — no real DB/Redis needed.
 */

// ── Module-level mocks (hoisted by Jest before any import) ────────────────────

const TEST_JWT_SECRET = 'supersecretkey_that_is_at_least_32chars!!';

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 3000,
    JWT_SECRET: TEST_JWT_SECRET,
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

// Mock Redis: auth middleware calls redis.exists() to check token revocation;
// rateLimiter also uses redis. Return safe defaults so both pass.
const mockRedisExists        = jest.fn().mockResolvedValue(0);
const mockRedisZremrangebyscore = jest.fn().mockResolvedValue(0);
const mockRedisZcard         = jest.fn().mockResolvedValue(0);
const mockRedisZadd          = jest.fn().mockResolvedValue(0);
const mockRedisExpire        = jest.fn().mockResolvedValue(0);

jest.mock('../../src/config/redis', () => ({
  redis: {
    get:               jest.fn().mockResolvedValue(null),
    setex:             jest.fn().mockResolvedValue('OK'),
    del:               jest.fn().mockResolvedValue(1),
    exists:            (...args: unknown[]) => mockRedisExists(...args),
    zremrangebyscore:  (...args: unknown[]) => mockRedisZremrangebyscore(...args),
    zcard:             (...args: unknown[]) => mockRedisZcard(...args),
    zadd:              (...args: unknown[]) => mockRedisZadd(...args),
    expire:            (...args: unknown[]) => mockRedisExpire(...args),
  },
  redisSub: { on: jest.fn() },
}));

// Mock AppDataSource — RBAC middleware calls getRepository(ProjectMember).findOne
const mockFindOne   = jest.fn();
const mockGetRepository = jest.fn().mockReturnValue({ findOne: mockFindOne });

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    getRepository: (...args: unknown[]) => mockGetRepository(...args),
    initialize:    jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock IssueManager fully
const mockCreate       = jest.fn();
const mockGetBoard     = jest.fn();
const mockList         = jest.fn();
const mockGetById      = jest.fn();
const mockUpdate       = jest.fn();
const mockTransition   = jest.fn();
const mockAddWatcher   = jest.fn();
const mockRemoveWatcher = jest.fn();
const mockDeleteIssue  = jest.fn();

jest.mock('../../src/modules/issues/IssueManager', () => ({
  IssueManager: jest.fn().mockImplementation(() => ({
    create:         mockCreate,
    getBoard:       mockGetBoard,
    list:           mockList,
    getById:        mockGetById,
    update:         mockUpdate,
    transition:     mockTransition,
    addWatcher:     mockAddWatcher,
    removeWatcher:  mockRemoveWatcher,
    delete:         mockDeleteIssue,
  })),
}));

// SQS / notification bus referenced transitively
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient:          jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { ProjectRole } from '../../src/core/types/enums';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER_ID  = 'user-uuid-1';
const TEST_PROJECT_ID = 'proj-uuid-1';
const TEST_ISSUE_ID   = 'issue-uuid-1';

/** Build a signed JWT the auth middleware will accept */
function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-test-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

/** Simulate a project membership at the given role */
function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

/** Simulate no membership (RBAC should 403) */
function withNoMembership(): void {
  mockFindOne.mockResolvedValue(null);
}

// Fixture issue returned by the mocked manager
const MOCK_ISSUE = {
  id:        TEST_ISSUE_ID,
  projectId: TEST_PROJECT_ID,
  type:      'TASK',
  title:     'Fix the thing',
  priority:  'MEDIUM',
  version:   1,
};

const MOCK_BOARD = {
  columns: [
    { statusId: 'status-1', name: 'To Do', issues: [] },
    { statusId: 'status-2', name: 'In Progress', issues: [MOCK_ISSUE] },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issues API — /api/v1', () => {
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(() => {
    app   = createApp();
    token = makeToken();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Redis: token not revoked by default; rate limiter passes
    mockRedisExists.mockResolvedValue(0);
    mockRedisZcard.mockResolvedValue(0);
  });

  // ── GET /projects/:projectId/board ──────────────────────────────────────────

  describe('GET /api/v1/projects/:projectId/board', () => {
    it('1. no auth header → 401', async () => {
      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/board`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('2. valid token, VIEWER role → 200 + { data: { columns: [...] } }', async () => {
      withMembership(ProjectRole.VIEWER);
      mockGetBoard.mockResolvedValue(MOCK_BOARD);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/board`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toHaveProperty('columns');
      expect(Array.isArray(res.body.data.columns)).toBe(true);
    });

    it('3. valid token, no membership → 403', async () => {
      withNoMembership();

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/board`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  // ── POST /projects/:projectId/issues ────────────────────────────────────────

  describe('POST /api/v1/projects/:projectId/issues', () => {
    it('4. no auth → 401', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/issues`)
        .send({ type: 'TASK', title: 'New issue' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('5. valid auth + valid body → 201 + created issue', async () => {
      withMembership(ProjectRole.MEMBER);
      mockCreate.mockResolvedValue(MOCK_ISSUE);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/issues`)
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'TASK', title: 'Fix the thing' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toMatchObject({ type: 'TASK', title: 'Fix the thing' });
    });

    it('6. valid auth, missing required title → 400', async () => {
      withMembership(ProjectRole.MEMBER);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/issues`)
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'TASK' }); // title missing

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('7. valid auth, invalid type value → 400', async () => {
      withMembership(ProjectRole.MEMBER);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/issues`)
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'INVALID_TYPE', title: 'Something' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── PATCH /issues/:issueId ──────────────────────────────────────────────────

  describe('PATCH /api/v1/issues/:issueId', () => {
    it('8. valid auth, missing version → 400 (version is required by updateIssueSchema)', async () => {
      const res = await request(app.callback())
        .patch(`/api/v1/issues/${TEST_ISSUE_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Updated title' }); // version omitted

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.fields).toHaveProperty('version');
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ── POST /issues/:issueId/transitions ────────────────────────────────────

  describe('POST /api/v1/issues/:issueId/transitions', () => {
    const TARGET_STATUS_ID = 'aaaaaaaa-1111-1111-1111-111111111111';

    it('9. valid transition → 200 + updated issue', async () => {
      const transitioned = { ...MOCK_ISSUE, statusId: TARGET_STATUS_ID };
      mockTransition.mockResolvedValue(transitioned);

      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/transitions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ toStatusId: TARGET_STATUS_ID });

      expect(res.status).toBe(200);
      expect(res.body.data.statusId).toBe(TARGET_STATUS_ID);
      expect(mockTransition).toHaveBeenCalledWith(
        TEST_ISSUE_ID, TARGET_STATUS_ID, TEST_USER_ID, expect.any(String),
      );
    });

    it('10. missing toStatusId → 400', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/transitions`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockTransition).not.toHaveBeenCalled();
    });

    it('11. no auth → 401', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/transitions`)
        .send({ toStatusId: TARGET_STATUS_ID });

      expect(res.status).toBe(401);
    });
  });

  // ── POST /issues/:issueId/watchers ────────────────────────────────────────

  describe('POST /api/v1/issues/:issueId/watchers', () => {
    it('12. add watcher → 204', async () => {
      mockAddWatcher.mockResolvedValue(undefined);

      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/watchers`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
      expect(mockAddWatcher).toHaveBeenCalledWith(TEST_ISSUE_ID, TEST_USER_ID);
    });

    it('13. no auth → 401', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/watchers`);

      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /issues/:issueId/watchers ─────────────────────────────────────

  describe('DELETE /api/v1/issues/:issueId/watchers', () => {
    it('14. remove watcher → 204', async () => {
      mockRemoveWatcher.mockResolvedValue(undefined);

      const res = await request(app.callback())
        .delete(`/api/v1/issues/${TEST_ISSUE_ID}/watchers`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
      expect(mockRemoveWatcher).toHaveBeenCalledWith(TEST_ISSUE_ID, TEST_USER_ID);
    });
  });
});
