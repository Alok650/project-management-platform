/**
 * Route-level integration tests for project endpoints under /api/v1/projects.
 *
 * RBAC middleware is controlled by the mocked ProjectMember repository.
 * ProjectManager is fully mocked.
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

const mockRedisExists           = jest.fn().mockResolvedValue(0);
const mockRedisZremrangebyscore = jest.fn().mockResolvedValue(0);
const mockRedisZcard            = jest.fn().mockResolvedValue(0);
const mockRedisZadd             = jest.fn().mockResolvedValue(0);
const mockRedisExpire           = jest.fn().mockResolvedValue(0);

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

const mockProjectCreate       = jest.fn();
const mockProjectList         = jest.fn();
const mockProjectGet          = jest.fn();
const mockProjectUpdate       = jest.fn();
const mockProjectDelete       = jest.fn();
const mockProjectAddMember    = jest.fn();
const mockProjectListMembers  = jest.fn();
const mockProjectRemoveMember = jest.fn();

jest.mock('../../src/modules/projects/ProjectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    create:       mockProjectCreate,
    list:         mockProjectList,
    get:          mockProjectGet,
    update:       mockProjectUpdate,
    delete:       mockProjectDelete,
    addMember:    mockProjectAddMember,
    listMembers:  mockProjectListMembers,
    removeMember: mockProjectRemoveMember,
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
const TEST_MEMBER_ID  = '22222222-2222-2222-2222-222222222222';

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-project-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

const MOCK_PROJECT = {
  id:          TEST_PROJECT_ID,
  name:        'My Project',
  key:         'MYPROJ',
  description: null,
  ownerId:     TEST_USER_ID,
  createdAt:   new Date().toISOString(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Projects API — /api/v1/projects', () => {
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

  // ── POST / ───────────────────────────────────────────────────────────────

  describe('POST /api/v1/projects', () => {
    it('1. create project → 201', async () => {
      mockProjectCreate.mockResolvedValue(MOCK_PROJECT);

      const res = await request(app.callback())
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Project', key: 'MYPROJ' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'My Project', key: 'MYPROJ' });
    });

    it('2. missing name → 400', async () => {
      const res = await request(app.callback())
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ key: 'MYPROJ' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockProjectCreate).not.toHaveBeenCalled();
    });

    it('3. missing key → 400', async () => {
      const res = await request(app.callback())
        .post('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'My Project' });

      expect(res.status).toBe(400);
      expect(mockProjectCreate).not.toHaveBeenCalled();
    });

    it('4. no auth → 401', async () => {
      const res = await request(app.callback())
        .post('/api/v1/projects')
        .send({ name: 'My Project', key: 'MYPROJ' });

      expect(res.status).toBe(401);
    });
  });

  // ── GET / ────────────────────────────────────────────────────────────────

  describe('GET /api/v1/projects', () => {
    it('5. list projects → 200 + array', async () => {
      mockProjectList.mockResolvedValue([MOCK_PROJECT]);

      const res = await request(app.callback())
        .get('/api/v1/projects')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toMatchObject({ id: TEST_PROJECT_ID });
    });

    it('6. no auth → 401', async () => {
      const res = await request(app.callback()).get('/api/v1/projects');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /:projectId ──────────────────────────────────────────────────────

  describe('GET /api/v1/projects/:projectId', () => {
    it('7. VIEWER gets project → 200', async () => {
      withMembership(ProjectRole.VIEWER);
      mockProjectGet.mockResolvedValue(MOCK_PROJECT);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: TEST_PROJECT_ID });
    });

    it('8. no membership → 403', async () => {
      mockFindOne.mockResolvedValue(null);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  // ── PATCH /:projectId ────────────────────────────────────────────────────

  describe('PATCH /api/v1/projects/:projectId', () => {
    it('9. PROJECT_LEAD updates project → 200', async () => {
      withMembership(ProjectRole.PROJECT_LEAD);
      mockProjectUpdate.mockResolvedValue({ ...MOCK_PROJECT, name: 'Renamed' });

      const res = await request(app.callback())
        .patch(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed');
    });

    it('10. MEMBER role (insufficient) → 403', async () => {
      withMembership(ProjectRole.MEMBER);

      const res = await request(app.callback())
        .patch(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /:projectId ───────────────────────────────────────────────────

  describe('DELETE /api/v1/projects/:projectId', () => {
    it('11. ADMIN deletes project → 204', async () => {
      withMembership(ProjectRole.ADMIN);
      mockProjectDelete.mockResolvedValue(undefined);

      const res = await request(app.callback())
        .delete(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
    });

    it('12. PROJECT_LEAD role (insufficient for delete) → 403', async () => {
      withMembership(ProjectRole.PROJECT_LEAD);

      const res = await request(app.callback())
        .delete(`/api/v1/projects/${TEST_PROJECT_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(mockProjectDelete).not.toHaveBeenCalled();
    });
  });

  // ── Members ──────────────────────────────────────────────────────────────

  describe('GET /api/v1/projects/:projectId/members', () => {
    it('13. VIEWER lists members → 200', async () => {
      withMembership(ProjectRole.VIEWER);
      mockProjectListMembers.mockResolvedValue([
        { userId: TEST_USER_ID, role: ProjectRole.ADMIN },
      ]);

      const res = await request(app.callback())
        .get(`/api/v1/projects/${TEST_PROJECT_ID}/members`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('POST /api/v1/projects/:projectId/members', () => {
    it('14. ADMIN adds member → 201', async () => {
      withMembership(ProjectRole.ADMIN);
      mockProjectAddMember.mockResolvedValue({ userId: TEST_MEMBER_ID, role: ProjectRole.MEMBER });

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/members`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: TEST_MEMBER_ID, role: 'MEMBER' });

      expect(res.status).toBe(201);
    });

    it('15. invalid role value → 400', async () => {
      withMembership(ProjectRole.ADMIN);

      const res = await request(app.callback())
        .post(`/api/v1/projects/${TEST_PROJECT_ID}/members`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: TEST_MEMBER_ID, role: 'SUPER_ADMIN' });

      expect(res.status).toBe(400);
      expect(mockProjectAddMember).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/projects/:projectId/members/:userId', () => {
    it('16. ADMIN removes member → 204', async () => {
      withMembership(ProjectRole.ADMIN);
      mockProjectRemoveMember.mockResolvedValue(undefined);

      const res = await request(app.callback())
        .delete(`/api/v1/projects/${TEST_PROJECT_ID}/members/${TEST_MEMBER_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
    });
  });
});
