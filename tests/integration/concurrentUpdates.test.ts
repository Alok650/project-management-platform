/**
 * Integration test: Concurrent issue updates trigger optimistic locking.
 *
 * Two callers attempt to update the same issue with the same version number
 * at the same time. TypeORM's optimistic locking ensures one wins (returns the
 * saved issue) and the other loses (throws OptimisticLockVersionMismatchError
 * which IssueCommandService maps to a 409 ConflictError).
 */

// ── Module-level mocks must come before any imports ──────────────────────────

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    transaction: jest.fn(),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    }),
  },
}));

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    DB_POOL_MAX: 5,
    REDIS_URL: 'redis://localhost:6379',
  },
}));

jest.mock('../../src/config/redis', () => ({
  redis: { get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() },
  redisSub: { get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));

jest.mock('../../src/infrastructure/logger/Logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { AppDataSource } from '../../src/config/database';
import { IssueCommandService } from '../../src/modules/issues/IssueCommandService';
import { ConflictError } from '../../src/core/errors/errors';
import { IssueType, IssuePriority, SprintStatus, StatusCategory } from '../../src/core/types/enums';
import type { Issue } from '../../src/models/Issue';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-001',
    issueKey: 'PROJ-1',
    projectId: 'project-001',
    type: IssueType.TASK,
    title: 'Initial title',
    description: null,
    statusId: 'status-todo',
    priority: IssuePriority.MEDIUM,
    assigneeId: null,
    reporterId: 'user-001',
    parentId: null,
    sprintId: null,
    storyPoints: null,
    labels: [],
    version: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    project: {} as never,
    status: {} as never,
    sprint: null,
    assignee: null,
    reporter: {} as never,
    parent: null,
    ...overrides,
  } as Issue;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('IssueCommandService – concurrent updates (optimistic locking)', () => {
  const mockTransaction = AppDataSource.transaction as jest.Mock;

  let issueRepo: {
    findById: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
  };
  let projectRepo: { findById: jest.Mock };
  let workflowRepo: { findStatusesByProject: jest.Mock };
  let service: IssueCommandService;

  const existingIssue = buildIssue();
  const updatedIssue  = buildIssue({ title: 'Updated title', version: 2 });

  beforeEach(() => {
    jest.clearAllMocks();

    issueRepo   = { findById: jest.fn(), save: jest.fn(), softDelete: jest.fn() };
    projectRepo = { findById: jest.fn() };
    workflowRepo = { findStatusesByProject: jest.fn() };

    // Both concurrent callers start from the same existing issue
    issueRepo.findById.mockResolvedValue(existingIssue);

    service = new IssueCommandService(
      issueRepo as never,
      projectRepo as never,
      workflowRepo as never,
    );
  });

  it('returns the updated issue for the first caller and throws ConflictError (409) for the second', async () => {
    // First transaction succeeds; second simulates TypeORM's optimistic lock error
    const lockError = new Error('Version mismatch');
    lockError.name  = 'OptimisticLockVersionMismatchError';

    // findById is called once per update() call — first returns updated issue for
    // the ConflictError constructor path, second also returns the existing issue.
    // We keep issueRepo.findById always returning existingIssue (version 1).

    mockTransaction
      .mockResolvedValueOnce(updatedIssue) // first caller wins
      .mockRejectedValueOnce(lockError);   // second caller loses

    const [result1, result2] = await Promise.allSettled([
      service.update('issue-001', { title: 'Updated title', version: 1 }, 'user-001', 'corr-001'),
      service.update('issue-001', { title: 'Updated title', version: 1 }, 'user-002', 'corr-002'),
    ]);

    // One call must succeed with the saved issue
    expect(result1.status).toBe('fulfilled');
    if (result1.status === 'fulfilled') {
      expect(result1.value).toEqual(updatedIssue);
    }

    // The other must be rejected with a ConflictError (HTTP 409)
    expect(result2.status).toBe('rejected');
    if (result2.status === 'rejected') {
      const err = result2.reason as ConflictError;
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(/modified by another user/i);
    }
  });

  it('re-throws non-optimistic-lock errors from the transaction unchanged', async () => {
    const dbError = new Error('Unexpected DB failure');
    mockTransaction.mockRejectedValueOnce(dbError);

    await expect(
      service.update('issue-001', { title: 'x', version: 1 }, 'user-001', 'corr-001'),
    ).rejects.toThrow('Unexpected DB failure');
  });
});
