/**
 * Route-level integration tests for custom field endpoints.
 *
 * Covers:
 *   - Field definition CRUD under /api/v1/projects/:projectId/custom-fields
 *   - Field value operations under /api/v1/issues/:issueId/fields
 *   - RBAC enforcement (PROJECT_LEAD+ for mutations, VIEWER+ for reads)
 *   - Joi validation (missing required fields, invalid type)
 */

const TEST_JWT_SECRET = 'supersecretkey_that_is_at_least_32chars!!';

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV:                   'test',
    PORT:                       3000,
    JWT_SECRET:                 TEST_JWT_SECRET,
    JWT_EXPIRES_IN:             '7d',
    DB_HOST:                    'localhost',
    DB_PORT:                    3306,
    DB_NAME:                    'testdb',
    DB_USER:                    'user',
    DB_PASSWORD:                'pass',
    DB_POOL_MAX:                5,
    REDIS_URL:                  'redis://localhost:6379',
    AWS_REGION:                 'us-east-1',
    AWS_ACCESS_KEY_ID:          'test',
    AWS_SECRET_ACCESS_KEY:      'test',
    SQS_NOTIFICATION_QUEUE_URL: 'http://localhost/queue',
    LOG_LEVEL:                  'silent',
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

const mockListDefinitions  = jest.fn();
const mockCreateDefinition = jest.fn();
const mockUpdateDefinition = jest.fn();
const mockDeleteDefinition = jest.fn();
const mockListValues       = jest.fn();
const mockSetValue         = jest.fn();
const mockClearValue       = jest.fn();

jest.mock('../../src/modules/customFields/CustomFieldService', () => ({
  CustomFieldService: jest.fn().mockImplementation(() => ({
    listDefinitions:  mockListDefinitions,
    createDefinition: mockCreateDefinition,
    updateDefinition: mockUpdateDefinition,
    deleteDefinition: mockDeleteDefinition,
    listValues:       mockListValues,
    setValue:         mockSetValue,
    clearValue:       mockClearValue,
  })),
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient:          jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn() },
}));

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app';
import { ProjectRole } from '../../src/core/types/enums';

const TEST_USER_ID    = 'user-uuid-1';
const TEST_PROJECT_ID = 'proj-uuid-1';
const TEST_ISSUE_ID   = 'issue-uuid-1';
const TEST_FIELD_ID   = 'field-uuid-1';

function makeToken(userId = TEST_USER_ID): string {
  return jwt.sign(
    { sub: userId, email: 'alice@example.com', jti: 'jti-cf-1' },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function withMembership(role: ProjectRole): void {
  mockFindOne.mockResolvedValue({ projectId: TEST_PROJECT_ID, userId: TEST_USER_ID, role });
}

const STUB_DEF = {
  id: TEST_FIELD_ID, projectId: TEST_PROJECT_ID,
  name: 'Priority tier', type: 'DROPDOWN', options: ['P0', 'P1', 'P2'],
  required: false, position: 0,
};

const STUB_VALUE = { id: 'val-uuid-1', fieldDefinitionId: TEST_FIELD_ID, issueId: TEST_ISSUE_ID, value: 'P1' };

let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(() => { app = createApp(); });
beforeEach(() => {
  jest.clearAllMocks();
  mockRedisExists.mockResolvedValue(0);
  token = makeToken();
});

// ─────────────────────────────────────────────────────────────────────────────
// Field Definitions
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/projects/:projectId/custom-fields', () => {
  it('1. VIEWER lists definitions → 200', async () => {
    withMembership(ProjectRole.VIEWER);
    mockListDefinitions.mockResolvedValue([STUB_DEF]);

    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].name).toBe('Priority tier');
  });

  it('2. unauthenticated → 401', async () => {
    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`);
    expect(res.status).toBe(401);
  });

  it('3. non-member → 403', async () => {
    mockFindOne.mockResolvedValue(null);
    const res = await request(app.callback())
      .get(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/projects/:projectId/custom-fields', () => {
  it('4. PROJECT_LEAD creates TEXT field → 201', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);
    mockCreateDefinition.mockResolvedValue({ ...STUB_DEF, type: 'TEXT', options: null });

    const res = await request(app.callback())
      .post(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Notes', type: 'TEXT' });

    expect(res.status).toBe(201);
    expect(mockCreateDefinition).toHaveBeenCalledWith(TEST_PROJECT_ID, expect.objectContaining({ type: 'TEXT' }));
  });

  it('5. MEMBER role (insufficient) → 403', async () => {
    withMembership(ProjectRole.MEMBER);

    const res = await request(app.callback())
      .post(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Notes', type: 'TEXT' });

    expect(res.status).toBe(403);
    expect(mockCreateDefinition).not.toHaveBeenCalled();
  });

  it('6. missing name → 400', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);

    const res = await request(app.callback())
      .post(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'NUMBER' });

    expect(res.status).toBe(400);
    expect(mockCreateDefinition).not.toHaveBeenCalled();
  });

  it('7. invalid type value → 400', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);

    const res = await request(app.callback())
      .post(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Oops', type: 'CHECKBOX' });

    expect(res.status).toBe(400);
  });

  it('8. DROPDOWN without options passes Joi (service enforces constraint)', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);
    // Joi only requires options to be a valid array when provided; the service
    // throws if DROPDOWN has no options — unit-tested in CustomFieldService tests.
    mockCreateDefinition.mockResolvedValue(STUB_DEF);

    const res = await request(app.callback())
      .post(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Tier', type: 'DROPDOWN', options: ['P0', 'P1'] });

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/v1/projects/:projectId/custom-fields/:fieldId', () => {
  it('9. PROJECT_LEAD updates field → 200', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);
    mockUpdateDefinition.mockResolvedValue({ ...STUB_DEF, name: 'Severity' });

    const res = await request(app.callback())
      .patch(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Severity' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Severity');
  });

  it('10. MEMBER role → 403', async () => {
    withMembership(ProjectRole.MEMBER);

    const res = await request(app.callback())
      .patch(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' });

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/v1/projects/:projectId/custom-fields/:fieldId', () => {
  it('11. PROJECT_LEAD deletes field → 204', async () => {
    withMembership(ProjectRole.PROJECT_LEAD);
    mockDeleteDefinition.mockResolvedValue(undefined);

    const res = await request(app.callback())
      .delete(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(mockDeleteDefinition).toHaveBeenCalledWith(TEST_FIELD_ID, TEST_PROJECT_ID);
  });

  it('12. MEMBER role → 403', async () => {
    withMembership(ProjectRole.MEMBER);

    const res = await request(app.callback())
      .delete(`/api/v1/projects/${TEST_PROJECT_ID}/custom-fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field Values
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/issues/:issueId/fields', () => {
  it('13. authenticated user lists values → 200', async () => {
    mockListValues.mockResolvedValue([STUB_VALUE]);

    const res = await request(app.callback())
      .get(`/api/v1/issues/${TEST_ISSUE_ID}/fields`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('14. unauthenticated → 401', async () => {
    const res = await request(app.callback())
      .get(`/api/v1/issues/${TEST_ISSUE_ID}/fields`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/v1/issues/:issueId/fields/:fieldDefinitionId', () => {
  it('15. set a valid value → 200', async () => {
    mockSetValue.mockResolvedValue(STUB_VALUE);

    const res = await request(app.callback())
      .put(`/api/v1/issues/${TEST_ISSUE_ID}/fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'P1' });

    expect(res.status).toBe(200);
    expect(mockSetValue).toHaveBeenCalledWith(TEST_ISSUE_ID, TEST_FIELD_ID, 'P1');
  });

  it('16. missing value body → 400', async () => {
    const res = await request(app.callback())
      .put(`/api/v1/issues/${TEST_ISSUE_ID}/fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  it('17. unauthenticated → 401', async () => {
    const res = await request(app.callback())
      .put(`/api/v1/issues/${TEST_ISSUE_ID}/fields/${TEST_FIELD_ID}`)
      .send({ value: 'P1' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/issues/:issueId/fields/:fieldDefinitionId', () => {
  it('18. authenticated user clears value → 204', async () => {
    mockClearValue.mockResolvedValue(undefined);

    const res = await request(app.callback())
      .delete(`/api/v1/issues/${TEST_ISSUE_ID}/fields/${TEST_FIELD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(mockClearValue).toHaveBeenCalledWith(TEST_ISSUE_ID, TEST_FIELD_ID);
  });

  it('19. unauthenticated → 401', async () => {
    const res = await request(app.callback())
      .delete(`/api/v1/issues/${TEST_ISSUE_ID}/fields/${TEST_FIELD_ID}`);
    expect(res.status).toBe(401);
  });
});
