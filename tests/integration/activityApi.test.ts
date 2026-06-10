/**
 * Route-level integration tests for the activity feed endpoint.
 *
 * ActivityService is mocked — no real DB/Redis needed beyond auth fakes.
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

const mockActivityList = jest.fn();

jest.mock('../../src/modules/activity/ActivityService', () => ({
  ActivityService: jest.fn().mockImplementation(() => ({
    list: mockActivityList,
  })),
}));

jest.mock('../../src/modules/activity/ActivityRepository', () => ({
  ActivityRepository: jest.fn().mockImplementation(() => ({})),
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

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-activity-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

const MOCK_LOG = {
  id:         'log-uuid-1',
  projectId:  TEST_PROJECT_ID,
  actorId:    TEST_USER_ID,
  entityType: 'ISSUE',
  entityId:   'issue-uuid-1',
  action:     'CREATED',
  createdAt:  new Date().toISOString(),
};

const MOCK_ACTIVITY_PAGE = {
  items:      [MOCK_LOG],
  nextCursor: null,
  hasMore:    false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Activity API — /api/v1/projects/:projectId/activity', () => {
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

  it('1. no auth → 401', async () => {
    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/activity`);

    expect(res.status).toBe(401);
  });

  it('2. VIEWER → 200 + paginated activity log', async () => {
    withMembership(ProjectRole.VIEWER);
    mockActivityList.mockResolvedValue(MOCK_ACTIVITY_PAGE);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/activity`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('items');
    expect(res.body.data.items[0]).toMatchObject({ action: 'CREATED', entityType: 'ISSUE' });
  });

  it('3. query filters forwarded to service (actorId, entityType)', async () => {
    withMembership(ProjectRole.VIEWER);
    mockActivityList.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/activity?actorId=user-1&entityType=ISSUE`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockActivityList).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      expect.objectContaining({ actorId: 'user-1', entityType: 'ISSUE' }),
      undefined,
      expect.any(Number),
    );
  });

  it('4. cursor-based pagination param forwarded', async () => {
    withMembership(ProjectRole.VIEWER);
    mockActivityList.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });

    const cursor = 'dGVzdC1jdXJzb3I=';
    await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/activity?cursor=${cursor}`)
      .set('Authorization', `Bearer ${token}`);

    expect(mockActivityList).toHaveBeenCalledWith(
      TEST_PROJECT_ID,
      expect.any(Object),
      cursor,
      expect.any(Number),
    );
  });

  it('5. no membership → 403', async () => {
    mockFindOne.mockResolvedValue(null);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/activity`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
