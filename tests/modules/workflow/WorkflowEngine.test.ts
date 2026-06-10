/**
 * Unit tests for WorkflowEngine.transition()
 *
 * All external collaborators are mocked at the module level so no real
 * database or event infrastructure is needed.
 */

// ── Mock declarations must be hoisted before any imports ──────────────────────

const mockFindTransition         = jest.fn();
const mockFindAllowedTransitions = jest.fn();

jest.mock('../../../src/modules/workflow/WorkflowRepository', () => ({
  WorkflowRepository: jest.fn().mockImplementation(() => ({
    findTransition:         mockFindTransition,
    findAllowedTransitions: mockFindAllowedTransitions,
  })),
}));

const mockHookRunnerRun = jest.fn();

jest.mock('../../../src/modules/workflow/ValidationHookRunner', () => ({
  ValidationHookRunner: jest.fn().mockImplementation(() => ({
    run: mockHookRunnerRun,
  })),
}));

const mockActionExecutorExecute = jest.fn();

jest.mock('../../../src/modules/workflow/AutoActionExecutor', () => ({
  AutoActionExecutor: jest.fn().mockImplementation(() => ({
    execute: mockActionExecutorExecute,
  })),
}));

// WipLimitHook / RequiredFieldHook are only exercised via ValidationHookRunner
// (which is fully mocked above). Stubs prevent import-time side-effects.
jest.mock('../../../src/modules/workflow/hooks/WipLimitHook',     () => ({ WipLimitHook: jest.fn() }));
jest.mock('../../../src/modules/workflow/hooks/RequiredFieldHook', () => ({ RequiredFieldHook: jest.fn() }));

const mockEmUpdate      = jest.fn();
const mockEmFindOneOrFail = jest.fn();
const mockTransaction   = jest.fn();

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    transaction: mockTransaction,
    getRepository: jest.fn(),
  },
}));

const mockEventBusPublish = jest.fn();

jest.mock('../../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: mockEventBusPublish },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import { WorkflowEngine }     from '../../../src/modules/workflow/WorkflowEngine';
import { UnprocessableError } from '../../../src/core/errors/errors';
import { IssueType, IssuePriority, StatusCategory } from '../../../src/core/types/enums';
import type { Issue }               from '../../../src/models/Issue';
import type { WorkflowTransition }  from '../../../src/models/WorkflowTransition';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id:          'issue-1',
    issueKey:    'PROJ-1',
    projectId:   'project-1',
    type:        IssueType.STORY,
    title:       'Test story',
    description: null,
    statusId:    'status-todo',
    priority:    IssuePriority.MEDIUM,
    assigneeId:  null,
    reporterId:  'user-1',
    parentId:    null,
    sprintId:    null,
    storyPoints: 5,
    labels:      [],
    version:     1,
    createdAt:   new Date(),
    updatedAt:   new Date(),
    deletedAt:   null,
    // relations (not needed for unit tests)
    project:   undefined as any,
    status:    undefined as any,
    sprint:    null,
    assignee:  null,
    reporter:  undefined as any,
    parent:    null,
    ...overrides,
  };
}

function makeTransition(overrides: Partial<WorkflowTransition> = {}): WorkflowTransition {
  return {
    id:           'trans-1',
    projectId:    'project-1',
    fromStatusId: 'status-todo',
    toStatusId:   'status-in-progress',
    name:         'Start work',
    createdAt:    new Date(),
    toStatus: {
      id:       'status-in-progress',
      name:     'In Progress',
      category: StatusCategory.IN_PROGRESS,
      wipLimit: null,
      position: 2,
      projectId: 'project-1',
      createdAt: new Date(),
      project: undefined as any,
    } as any,
    autoActions:  [],
    // relations
    project:      undefined as any,
    fromStatus:   undefined as any,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('WorkflowEngine.transition()', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: transaction immediately calls its callback
    mockTransaction.mockImplementation(async (cb: (em: any) => Promise<any>) =>
      cb({ update: mockEmUpdate, findOneOrFail: mockEmFindOneOrFail }),
    );

    // Hook runner succeeds by default
    mockHookRunnerRun.mockResolvedValue(undefined);

    // Action executor succeeds by default
    mockActionExecutorExecute.mockResolvedValue(undefined);

    engine = new WorkflowEngine();
  });

  // ── 1. Happy path ────────────────────────────────────────────────────────────

  it('returns updated issue and publishes StatusChangedEvent on a valid transition', async () => {
    const issue      = makeIssue();
    const transition = makeTransition();
    const updated    = makeIssue({ statusId: 'status-in-progress' });

    mockFindTransition.mockResolvedValue(transition);
    mockEmUpdate.mockResolvedValue(undefined);
    mockEmFindOneOrFail.mockResolvedValue(updated);

    const result = await engine.transition(issue, 'status-in-progress', 'actor-1', 'corr-1');

    expect(result).toBe(updated);

    // Persisted with correct status
    expect(mockEmUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'issue-1' },
      { statusId: 'status-in-progress' },
    );

    // Event published with correct shape
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const publishedEvent = mockEventBusPublish.mock.calls[0]?.[0];
    expect(publishedEvent).toMatchObject({
      type:    'StatusChanged',
      payload: {
        issueId:      'issue-1',
        projectId:    'project-1',
        fromStatusId: 'status-todo',
        toStatusId:   'status-in-progress',
        actorId:      'actor-1',
      },
    });
  });

  it('passes the correct TransitionContext to the hook runner', async () => {
    const issue      = makeIssue();
    const transition = makeTransition();
    const updated    = makeIssue({ statusId: 'status-in-progress' });

    mockFindTransition.mockResolvedValue(transition);
    mockEmFindOneOrFail.mockResolvedValue(updated);

    await engine.transition(issue, 'status-in-progress', 'actor-99', 'corr-99');

    expect(mockHookRunnerRun).toHaveBeenCalledWith({
      issue,
      transition,
      actorId:       'actor-99',
      correlationId: 'corr-99',
    });
  });

  // ── 2. Disallowed transition ──────────────────────────────────────────────────

  it('throws UnprocessableError when the transition is not configured', async () => {
    const issue = makeIssue();

    mockFindTransition.mockResolvedValue(null);
    mockFindAllowedTransitions.mockResolvedValue([
      { toStatusId: 'status-done' },
      { toStatusId: 'status-in-progress' },
    ]);

    await expect(
      engine.transition(issue, 'status-blocked', 'actor-1', 'corr-1'),
    ).rejects.toBeInstanceOf(UnprocessableError);

    // Should include the allowed-transitions hint
    const error = (await engine
      .transition(issue, 'status-blocked', 'actor-1', 'corr-1')
      .catch((e: unknown) => e)) as UnprocessableError;

    expect(error.allowedTransitions).toEqual(
      expect.arrayContaining(['status-done', 'status-in-progress']),
    );

    // Must not touch the DB or event bus
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it('does not run hooks when the transition lookup fails', async () => {
    const issue = makeIssue();

    mockFindTransition.mockResolvedValue(null);
    mockFindAllowedTransitions.mockResolvedValue([]);

    await expect(
      engine.transition(issue, 'status-unknown', 'actor-1', 'corr-1'),
    ).rejects.toBeInstanceOf(UnprocessableError);

    expect(mockHookRunnerRun).not.toHaveBeenCalled();
  });

  // ── 3. WIP limit exceeded ────────────────────────────────────────────────────

  it('rethrows UnprocessableError from hookRunner when WIP limit is exceeded', async () => {
    const issue      = makeIssue();
    const transition = makeTransition({
      toStatus: {
        id:        'status-in-progress',
        name:      'In Progress',
        category:  StatusCategory.IN_PROGRESS,
        wipLimit:  3,
        position:  2,
        projectId: 'project-1',
        createdAt: new Date(),
        project:   undefined as any,
      } as any,
    });

    mockFindTransition.mockResolvedValue(transition);
    mockHookRunnerRun.mockRejectedValue(
      new UnprocessableError("WIP limit of 3 reached for status 'In Progress'"),
    );

    await expect(
      engine.transition(issue, 'status-in-progress', 'actor-1', 'corr-1'),
    ).rejects.toBeInstanceOf(UnprocessableError);

    // Transition must be aborted — no DB write, no event
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  // ── 4. RequiredFieldHook blocks DONE ─────────────────────────────────────────

  it('throws UnprocessableError when RequiredFieldHook blocks a DONE transition for a Story without story points', async () => {
    const issue = makeIssue({ storyPoints: null, type: IssueType.STORY });
    const transition = makeTransition({
      toStatusId: 'status-done',
      toStatus: {
        id:        'status-done',
        name:      'Done',
        category:  StatusCategory.DONE,
        wipLimit:  null,
        position:  3,
        projectId: 'project-1',
        createdAt: new Date(),
        project:   undefined as any,
      } as any,
    });

    mockFindTransition.mockResolvedValue(transition);
    mockHookRunnerRun.mockRejectedValue(
      new UnprocessableError('Story points are required before moving to Done'),
    );

    const error = (await engine
      .transition(issue, 'status-done', 'actor-1', 'corr-1')
      .catch((e: unknown) => e)) as UnprocessableError;

    expect(error).toBeInstanceOf(UnprocessableError);
    expect(error.message).toContain('Story points');

    // No side-effects
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  // ── 5. autoActions are skipped when array is empty ───────────────────────────

  it('does not call AutoActionExecutor when the transition has no autoActions', async () => {
    const issue      = makeIssue();
    const transition = makeTransition({ autoActions: [] });
    const updated    = makeIssue({ statusId: 'status-in-progress' });

    mockFindTransition.mockResolvedValue(transition);
    mockEmFindOneOrFail.mockResolvedValue(updated);

    await engine.transition(issue, 'status-in-progress', 'actor-1', 'corr-1');

    expect(mockActionExecutorExecute).not.toHaveBeenCalled();
  });

  it('calls AutoActionExecutor when the transition has autoActions', async () => {
    const autoAction = { id: 'action-1', type: 'ASSIGN_REVIEWER', config: { assignTo: 'current_user' } } as any;
    const issue      = makeIssue();
    const transition = makeTransition({ autoActions: [autoAction] });
    const updated    = makeIssue({ statusId: 'status-in-progress' });

    mockFindTransition.mockResolvedValue(transition);
    mockEmFindOneOrFail.mockResolvedValue(updated);

    await engine.transition(issue, 'status-in-progress', 'actor-1', 'corr-1');

    expect(mockActionExecutorExecute).toHaveBeenCalledWith(
      [autoAction],
      updated,
      'actor-1',
    );
  });
});
