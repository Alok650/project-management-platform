/**
 * Integration test: Workflow validation hooks block invalid transitions.
 *
 * Verifies that ValidationHookRunner correctly short-circuits on the first
 * failing hook: when WipLimitHook blocks the transition, RequiredFieldHook
 * must never be called, and the runner must throw an UnprocessableError whose
 * message references the WIP limit.
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    transaction: jest.fn(),
    getRepository: jest.fn(),
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
import { ValidationHookRunner } from '../../src/modules/workflow/ValidationHookRunner';
import { WipLimitHook } from '../../src/modules/workflow/hooks/WipLimitHook';
import { RequiredFieldHook } from '../../src/modules/workflow/hooks/RequiredFieldHook';
import { UnprocessableError } from '../../src/core/errors/errors';
import { IssueType, IssuePriority, StatusCategory } from '../../src/core/types/enums';
import type { TransitionContext } from '../../src/modules/workflow/hooks/IValidationHook';
import type { Issue } from '../../src/models/Issue';
import type { WorkflowTransition } from '../../src/models/WorkflowTransition';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildContext(overrides: Partial<TransitionContext> = {}): TransitionContext {
  const issue: Issue = {
    id: 'issue-001',
    issueKey: 'PROJ-1',
    projectId: 'project-001',
    type: IssueType.TASK,
    title: 'Some issue',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    project: {} as never,
    status: {} as never,
    sprint: null,
    assignee: null,
    reporter: {} as never,
    parent: null,
  } as Issue;

  const transition = {
    id: 'transition-001',
    fromStatusId: 'status-todo',
    toStatusId: 'status-in-progress',
    toStatus: {
      id: 'status-in-progress',
      name: 'In Progress',
      category: StatusCategory.IN_PROGRESS,
      wipLimit: 3,
    },
    autoActions: [],
  } as unknown as WorkflowTransition;

  return {
    issue,
    transition,
    actorId: 'user-001',
    correlationId: 'corr-001',
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ValidationHookRunner – short-circuits on first failing hook', () => {
  const WIP_LIMIT = 3;
  const mockGetRepository = AppDataSource.getRepository as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws UnprocessableError with WIP message when limit is reached', async () => {
    // WIP limit is 3, current count is 3 → hook should block
    const countMock = jest.fn().mockResolvedValue(WIP_LIMIT);
    mockGetRepository.mockReturnValue({ count: countMock });

    const wipHook      = new WipLimitHook();
    const requiredHook = new RequiredFieldHook();
    const validateSpy  = jest.spyOn(requiredHook, 'validate');

    const runner = new ValidationHookRunner([wipHook, requiredHook]);

    await expect(runner.run(buildContext())).rejects.toThrow(UnprocessableError);
    await expect(runner.run(buildContext())).rejects.toThrow(/WIP limit.*3/i);
  });

  it('does NOT call RequiredFieldHook when WipLimitHook blocks the transition', async () => {
    const countMock = jest.fn().mockResolvedValue(WIP_LIMIT);
    mockGetRepository.mockReturnValue({ count: countMock });

    const wipHook      = new WipLimitHook();
    const requiredHook = new RequiredFieldHook();
    const validateSpy  = jest.spyOn(requiredHook, 'validate');

    const runner = new ValidationHookRunner([wipHook, requiredHook]);

    try {
      await runner.run(buildContext());
    } catch {
      // expected error — we only care that the spy was never reached
    }

    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('proceeds to RequiredFieldHook when WIP limit is NOT reached', async () => {
    // Count is 2 (below limit of 3) — WipLimitHook passes
    const countMock = jest.fn().mockResolvedValue(2);
    mockGetRepository.mockReturnValue({ count: countMock });

    const wipHook      = new WipLimitHook();
    const requiredHook = new RequiredFieldHook();
    const validateSpy  = jest.spyOn(requiredHook, 'validate');

    const runner = new ValidationHookRunner([wipHook, requiredHook]);

    // Context: TASK type going to IN_PROGRESS — RequiredFieldHook returns null (no error)
    await expect(runner.run(buildContext())).resolves.toBeUndefined();

    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it('reports UnprocessableError status code 422', async () => {
    const countMock = jest.fn().mockResolvedValue(WIP_LIMIT);
    mockGetRepository.mockReturnValue({ count: countMock });

    const runner = new ValidationHookRunner([new WipLimitHook(), new RequiredFieldHook()]);

    let caughtError: unknown;
    try {
      await runner.run(buildContext());
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(UnprocessableError);
    expect((caughtError as UnprocessableError).statusCode).toBe(422);
  });
});
