/**
 * Route-level integration tests for sprint endpoints under /api/v1.
 *
 * Auth middleware is exercised with a real JWT. RBAC is controlled via the
 * mocked ProjectMember repository. SprintManager is fully mocked.
 */

const TEST_JWT_SECRET = 'supersecretkey_that_is_at_least_32chars!!';

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV:                    'test',
    PORT:                        3000,
    JWT_SECRET:                  TEST_JWT_SECRET,
    JWT_EXPIRES_IN:              '7d',
    DB_HOST:                     'localhost',
    DB_PORT:                     3306,
    DB_NAME:                     'testdb',
    DB_USER:                     'user',
    DB_PASSWORD:                 'pass',
    DB_POOL_MAX:                 5,
    REDIS_URL:                   'redis://localhost:6379',
    AWS_REGION:                  'us-east-1',
    AWS_ACCESS_KEY_ID:           'test',
    AWS_SECRET_ACCESS_KEY:       'test',
    SQS_NOTIFICATION_QUEUE_URL:  'http://localhost/queue',
    LOG_LEVEL:                   'silent',
  },
}));

const mockRedisExists        = jest.fn().mockResolvedValue(0);
const mockRedisZremrangebyscore = jest.fn().mockResolvedValue(0);
const mockRedisZcard         = jest.fn().mockResolvedValue(0);
const mockRedisZadd          = jest.fn().mockResolvedValue(0);
const mockRedisExpire        = jest.fn().mockResolvedValue(0);

jest.mock('../../src/config/redis', () => ({
  redis: {
    get:              jest.fn().mockResolvedValue(null),
    setex:            jest.fn().mockResolvedValue('OK'),
    del:              jest.fn().mockResolvedValue(1),
    exists:           (...args: unknown[]) => mockRedisExists(...args),
    zremrangebyscore: (...args: unknown[]) => mockRedisZremrangebyscore(...args),
    zcard:            (...args: unknown[]) => mockRedisZcard(...args),
    zadd:             (...args: unknown[]) => mockRedisZadd(...args),
    expire:           (...args: unknown[]) => mockRedisExpire(...args),
  },
  redisSub: { on: jest.fn() },
}));

const mockFindOne       = jest.fn();
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

const mockSprintList     = jest.fn();
const mockSprintCreate   = jest.fn();
const mockSprintStart    = jest.fn();
const mockSprintComplete = jest.fn();

jest.mock('../../src/modules/sprints/SprintManager', () => ({
  SprintManager: jest.fn().mockImplementation(() => ({
    list:     mockSprintList,
    create:   mockSprintCreate,
    start:    mockSprintStart,
    complete: mockSprintComplete,
  })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient:          jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { ProjectRole } from '../../src/core/types/enums';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER_ID    = 'user-uuid-1';
const TEST_PROJECT_ID = 'proj-uuid-1';
const TEST_SPRINT_ID  = 'sprint-uuid-1';

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-sprint-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

const MOCK_SPRINT = {
  id:        TEST_SPRINT_ID,
  projectId: TEST_PROJECT_ID,
  name:      'Sprint 1',
  status:    'PLANNED',
  goal:      null,
  startDate: null,
  endDate:   null,
  createdAt: new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sprint API — /api/v1', () => {
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(() => {
    app   = createApp();
    token = makeToken();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisExists.mockResolvedValue(0);
    mockRedisZcard.mockResolvedValue(0);
  });

  // ── GET /projects/:projectId/sprints ─────────────────────────────────────

  describe('GET /api/v1/projects/:projectId/sprints', () => {
    it('1. no auth → 401', async () => {
      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('2. VIEWER role → 200 + sprint array', async () => {
      withMembership(ProjectRole.VIEWER);
      mockSprintList.mockResolvedValue([MOCK_SPRINT]);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toMatchObject({ id: TEST_SPRINT_ID, name: 'Sprint 1' });
    });

    it('3. no membership → 403', async () => {
      mockFindOne.mockResolvedValue(null);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  // ── POST /projects/:projectId/sprints ────────────────────────────────────

  describe('POST /api/v1/projects/:projectId/sprints', () => {
    it('4. PROJECT_LEAD creates sprint → 201', async () => {
      withMembership(ProjectRole.PROJECT_LEAD);
      mockSprintCreate.mockResolvedValue(MOCK_SPRINT);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Sprint 1' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'Sprint 1', status: 'PLANNED' });
    });

    it('5. missing name → 400 VALIDATION_ERROR', async () => {
      withMembership(ProjectRole.PROJECT_LEAD);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockSprintCreate).not.toHaveBeenCalled();
    });

    it('6. MEMBER role (insufficient) → 403', async () => {
      withMembership(ProjectRole.MEMBER);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/sprints`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Sprint 1' });

      expect(res.status).toBe(403);
      expect(mockSprintCreate).not.toHaveBeenCalled();
    });
  });

  // ── POST /sprints/:sprintId/start ────────────────────────────────────────

  describe('POST /api/v1/sprints/:sprintId/start', () => {
    it('7. start sprint → 200 with ACTIVE status', async () => {
      mockSprintStart.mockResolvedValue({ ...MOCK_SPRINT, status: 'ACTIVE' });

      const res = await request(app.callback())
        .post(`/api/v1/sprints/${TEST_SPRINT_ID}/start`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('8. no auth → 401', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/sprints/${TEST_SPRINT_ID}/start`);

      expect(res.status).toBe(401);
    });
  });

  // ── POST /sprints/:sprintId/complete ─────────────────────────────────────

  describe('POST /api/v1/sprints/:sprintId/complete', () => {
    it('9. complete sprint with carryover → 200 + velocity', async () => {
      mockSprintComplete.mockResolvedValue({ ...MOCK_SPRINT, status: 'COMPLETED', velocity: 21 });

      const res = await request(app.callback())
        .post(`/api/v1/sprints/${TEST_SPRINT_ID}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ carryOverIssueIds: ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'] });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.velocity).toBe(21);
    });

    it('10. complete sprint with empty carryover → 200', async () => {
      mockSprintComplete.mockResolvedValue({ ...MOCK_SPRINT, status: 'COMPLETED', velocity: 0 });

      const res = await request(app.callback())
        .post(`/api/v1/sprints/${TEST_SPRINT_ID}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ carryOverIssueIds: [] });

      expect(res.status).toBe(200);
    });
  });
});
