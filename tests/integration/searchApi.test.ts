/**
 * Route-level integration tests for the search endpoint.
 *
 * SearchRepository is mocked directly — no DB or Redis needed beyond auth/rate-limit fakes.
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

const mockSearchIssues   = jest.fn();
const mockSearchComments = jest.fn();

jest.mock('../../src/modules/search/SearchRepository', () => ({
  SearchRepository: jest.fn().mockImplementation(() => ({
    searchIssues:   mockSearchIssues,
    searchComments: mockSearchComments,
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

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-search-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

const MOCK_ISSUE_PAGE = {
  items:      [{ id: 'issue-1', title: 'Fix login bug', score: 0.95 }],
  nextCursor: null,
  hasMore:    false,
};

const MOCK_COMMENT_PAGE = {
  items:      [{ id: 'comment-1', content: 'looks good', score: 0.8 }],
  nextCursor: null,
  hasMore:    false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Search API — /api/v1/projects/:projectId/search', () => {
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
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search?q=bug`);

    expect(res.status).toBe(401);
  });

  it('2. VIEWER with valid q → 200 + issues', async () => {
    withMembership(ProjectRole.VIEWER);
    mockSearchIssues.mockResolvedValue(MOCK_ISSUE_PAGE);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search?q=login`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('items');
    expect(mockSearchIssues).toHaveBeenCalled();
    expect(mockSearchComments).not.toHaveBeenCalled();
  });

  it('3. type=COMMENT routes to searchComments', async () => {
    withMembership(ProjectRole.VIEWER);
    mockSearchComments.mockResolvedValue(MOCK_COMMENT_PAGE);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search?q=fix&type=COMMENT`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockSearchComments).toHaveBeenCalled();
    expect(mockSearchIssues).not.toHaveBeenCalled();
  });

  it('4. missing q → 400', async () => {
    withMembership(ProjectRole.VIEWER);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(mockSearchIssues).not.toHaveBeenCalled();
  });

  it('5. q shorter than MIN_QUERY_LENGTH (2 chars) → 400', async () => {
    withMembership(ProjectRole.VIEWER);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search?q=a`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(mockSearchIssues).not.toHaveBeenCalled();
  });

  it('6. no project membership → 403', async () => {
    mockFindOne.mockResolvedValue(null);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/search?q=login`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
