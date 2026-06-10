/**
 * Route-level integration tests for comment endpoints under /api/v1.
 *
 * Comment routes have no RBAC middleware (only authentication). CommentManager
 * is fully mocked — no real DB needed.
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
    exists:           (...args: unknown[]) => mockRedisExists(...args),
    zremrangebyscore: (...args: unknown[]) => mockRedisZremrangebyscore(...args),
    zcard:            (...args: unknown[]) => mockRedisZcard(...args),
    zadd:             (...args: unknown[]) => mockRedisZadd(...args),
    expire:           (...args: unknown[]) => mockRedisExpire(...args),
  },
  redisSub: { on: jest.fn() },
}));

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn().mockReturnValue({ findOne: jest.fn() }),
    initialize:    jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCommentList   = jest.fn();
const mockCommentCreate = jest.fn();
const mockCommentUpdate = jest.fn();
const mockCommentDelete = jest.fn();

jest.mock('../../src/modules/comments/CommentManager', () => ({
  CommentManager: jest.fn().mockImplementation(() => ({
    list:   mockCommentList,
    create: mockCommentCreate,
    update: mockCommentUpdate,
    delete: mockCommentDelete,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER_ID    = 'user-uuid-1';
const TEST_ISSUE_ID   = 'issue-uuid-1';
const TEST_COMMENT_ID = 'comment-uuid-1';

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-comment-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const MOCK_COMMENT = {
  id:         TEST_COMMENT_ID,
  issueId:    TEST_ISSUE_ID,
  authorId:   TEST_USER_ID,
  content:    'Looking good!',
  parentId:   null,
  mentions:   [],
  createdAt:  new Date().toISOString(),
};

const MOCK_PAGE = {
  items:      [MOCK_COMMENT],
  nextCursor: null,
  hasMore:    false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Comments API — /api/v1', () => {
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

  // ── GET /issues/:issueId/comments ────────────────────────────────────────

  describe('GET /api/v1/issues/:issueId/comments', () => {
    it('1. no auth → 401', async () => {
      const res = await request(app.callback())
        .get(`/api/v1/issues/${TEST_ISSUE_ID}/comments`);

      expect(res.status).toBe(401);
    });

    it('2. valid auth → 200 + paginated list', async () => {
      mockCommentList.mockResolvedValue(MOCK_PAGE);

      const res = await request(app.callback())
        .get(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data.items[0]).toMatchObject({ id: TEST_COMMENT_ID });
    });
  });

  // ── POST /issues/:issueId/comments ───────────────────────────────────────

  describe('POST /api/v1/issues/:issueId/comments', () => {
    it('3. create top-level comment → 201', async () => {
      mockCommentCreate.mockResolvedValue(MOCK_COMMENT);

      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Looking good!' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ content: 'Looking good!' });
      expect(mockCommentCreate).toHaveBeenCalledWith(
        TEST_ISSUE_ID, TEST_USER_ID, 'Looking good!', undefined, expect.any(String),
      );
    });

    it('4. create reply comment with parentId → 201, parentId forwarded', async () => {
      const PARENT_ID    = '11111111-1111-1111-1111-111111111111';
      const replyComment = { ...MOCK_COMMENT, parentId: PARENT_ID };
      mockCommentCreate.mockResolvedValue(replyComment);

      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'I agree!', parentId: PARENT_ID });

      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(PARENT_ID);
      expect(mockCommentCreate).toHaveBeenCalledWith(
        TEST_ISSUE_ID, TEST_USER_ID, 'I agree!', PARENT_ID, expect.any(String),
      );
    });

    it('5. missing content → 400 VALIDATION_ERROR', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockCommentCreate).not.toHaveBeenCalled();
    });

    it('6. invalid parentId (not a uuid) → 400', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello', parentId: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(mockCommentCreate).not.toHaveBeenCalled();
    });

    it('7. no auth → 401', async () => {
      const res = await request(app.callback())
        .post(`/api/v1/issues/${TEST_ISSUE_ID}/comments`)
        .send({ content: 'Hello' });

      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /comments/:commentId ───────────────────────────────────────────

  describe('PATCH /api/v1/comments/:commentId', () => {
    it('8. author updates comment → 200', async () => {
      const updated = { ...MOCK_COMMENT, content: 'Updated content' };
      mockCommentUpdate.mockResolvedValue(updated);

      const res = await request(app.callback())
        .patch(`/api/v1/comments/${TEST_COMMENT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Updated content' });

      expect(res.status).toBe(200);
      expect(res.body.data.content).toBe('Updated content');
      expect(mockCommentUpdate).toHaveBeenCalledWith(TEST_COMMENT_ID, 'Updated content', TEST_USER_ID);
    });

    it('9. missing content → 400', async () => {
      const res = await request(app.callback())
        .patch(`/api/v1/comments/${TEST_COMMENT_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(mockCommentUpdate).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /comments/:commentId ──────────────────────────────────────────

  describe('DELETE /api/v1/comments/:commentId', () => {
    it('10. author deletes comment → 204', async () => {
      mockCommentDelete.mockResolvedValue(undefined);

      const res = await request(app.callback())
        .delete(`/api/v1/comments/${TEST_COMMENT_ID}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(204);
      expect(mockCommentDelete).toHaveBeenCalledWith(TEST_COMMENT_ID, TEST_USER_ID);
    });

    it('11. no auth → 401', async () => {
      const res = await request(app.callback())
        .delete(`/api/v1/comments/${TEST_COMMENT_ID}`);

      expect(res.status).toBe(401);
    });
  });
});
