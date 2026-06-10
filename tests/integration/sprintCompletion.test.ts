/**
 * Integration test: Sprint completion with carry-over logic.
 *
 * Verifies that completing an ACTIVE sprint:
 *  - Marks the sprint COMPLETED and stores velocity
 *  - Moves carry-over issues to the next sprint
 *  - Sends remaining incomplete issues to the backlog (sprintId = null)
 *  - Publishes a SprintUpdatedEvent on the domain event bus
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

jest.mock('../../src/config/database', () => ({
  AppDataSource: {
    transaction: jest.fn(),
    getRepository: jest.fn().mockReturnValue({
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
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
import { SprintService } from '../../src/modules/sprints/SprintService';
import { eventBus } from '../../src/core/events/DomainEventBus';
import { SprintStatus, IssueType, IssuePriority } from '../../src/core/types/enums';
import type { Sprint } from '../../src/models/Sprint';
import type { Issue } from '../../src/models/Issue';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-001',
    projectId: 'project-001',
    name: 'Sprint 1',
    goal: null,
    status: SprintStatus.ACTIVE,
    startDate: '2024-01-01',
    endDate: '2024-01-14',
    velocity: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    project: {} as never,
    ...overrides,
  } as Sprint;
}

function buildIssue(id: string, sprintId = 'sprint-001'): Issue {
  return {
    id,
    issueKey: `PROJ-${id}`,
    projectId: 'project-001',
    type: IssueType.TASK,
    title: `Issue ${id}`,
    description: null,
    statusId: 'status-in-progress',
    priority: IssuePriority.MEDIUM,
    assigneeId: null,
    reporterId: 'user-001',
    parentId: null,
    sprintId,
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
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SprintService – complete() with carry-over', () => {
  const mockTransaction = AppDataSource.transaction as jest.Mock;

  const activeSprint = buildSprint();
  const VELOCITY = 21;

  // 3 incomplete issues; we will carry over 2 of them
  const issue1 = buildIssue('issue-001');
  const issue2 = buildIssue('issue-002');
  const issue3 = buildIssue('issue-003');
  const incompleteIssues = [issue1, issue2, issue3];

  const NEXT_SPRINT_ID = 'sprint-002';
  const CARRY_OVER_IDS = [issue1.id, issue2.id]; // issue3 goes to backlog

  let sprintRepo: {
    findById: jest.Mock;
    findByProject: jest.Mock;
    findActive: jest.Mock;
    getVelocity: jest.Mock;
    getIncompleteIssues: jest.Mock;
    save: jest.Mock;
  };

  let service: SprintService;
  let publishSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    sprintRepo = {
      findById: jest.fn().mockResolvedValue(activeSprint),
      findByProject: jest.fn(),
      findActive: jest.fn(),
      getVelocity: jest.fn().mockResolvedValue(VELOCITY),
      getIncompleteIssues: jest.fn().mockResolvedValue(incompleteIssues),
      save: jest.fn(),
    };

    service = new SprintService(sprintRepo as never);
    publishSpy = jest.spyOn(eventBus, 'publish');

    // Wire AppDataSource.transaction to execute the callback with a mock em
    mockTransaction.mockImplementation(async (cb: (em: unknown) => Promise<unknown>) => {
      const issueUpdateMock = jest.fn().mockResolvedValue(undefined);
      const issueRepoMock   = { update: issueUpdateMock };

      const completedSprint = buildSprint({ status: SprintStatus.COMPLETED, velocity: VELOCITY });

      const em = {
        query:         jest.fn().mockResolvedValue(undefined),
        save:          jest.fn().mockResolvedValue(completedSprint),
        getRepository: jest.fn().mockReturnValue(issueRepoMock),
        _issueUpdate:  issueUpdateMock, // exposed for assertions below
      };

      // Store the em reference so we can inspect calls after the transaction
      (mockTransaction as jest.Mock & { lastEm?: typeof em }).lastEm = em;

      return cb(em);
    });
  });

  afterEach(() => {
    publishSpy.mockRestore();
  });

  it('marks the sprint COMPLETED with the velocity from getVelocity', async () => {
    const { sprint } = await service.complete(
      activeSprint.id,
      CARRY_OVER_IDS,
      NEXT_SPRINT_ID,
      'user-001',
      'corr-001',
    );

    expect(sprint.status).toBe(SprintStatus.COMPLETED);
    expect(sprint.velocity).toBe(VELOCITY);
    expect(sprintRepo.getVelocity).toHaveBeenCalledWith(activeSprint.id);
  });

  it('reports the correct count of incomplete issues', async () => {
    const { incompleteCount } = await service.complete(
      activeSprint.id,
      CARRY_OVER_IDS,
      NEXT_SPRINT_ID,
      'user-001',
      'corr-001',
    );

    expect(incompleteCount).toBe(incompleteIssues.length);
    expect(sprintRepo.getIncompleteIssues).toHaveBeenCalledWith(activeSprint.id);
  });

  it('moves carry-over issues to the next sprint and the remaining issue to backlog', async () => {
    await service.complete(
      activeSprint.id,
      CARRY_OVER_IDS,
      NEXT_SPRINT_ID,
      'user-001',
      'corr-001',
    );

    // Retrieve the mock em that the transaction callback received
    const em = (mockTransaction as jest.Mock & { lastEm?: { getRepository: jest.Mock } }).lastEm!;
    const issueRepo = em.getRepository.mock.results[0]?.value as { update: jest.Mock } | undefined;

    expect(issueRepo).toBeDefined();
    const updateCalls: Array<[{ id: string }, { sprintId: string | null }]> =
      issueRepo!.update.mock.calls;

    // issue1 → nextSprintId
    const call1 = updateCalls.find(([where]) => where.id === issue1.id);
    expect(call1).toBeDefined();
    expect(call1![1].sprintId).toBe(NEXT_SPRINT_ID);

    // issue2 → nextSprintId
    const call2 = updateCalls.find(([where]) => where.id === issue2.id);
    expect(call2).toBeDefined();
    expect(call2![1].sprintId).toBe(NEXT_SPRINT_ID);

    // issue3 → backlog (null)
    const call3 = updateCalls.find(([where]) => where.id === issue3.id);
    expect(call3).toBeDefined();
    expect(call3![1].sprintId).toBeNull();
  });

  it('publishes a SprintUpdatedEvent after completion', async () => {
    await service.complete(
      activeSprint.id,
      CARRY_OVER_IDS,
      NEXT_SPRINT_ID,
      'user-001',
      'corr-001',
    );

    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SprintUpdated',
        payload: expect.objectContaining({
          sprintId: activeSprint.id,
          projectId: activeSprint.projectId,
          actorId: 'user-001',
        }),
      }),
    );
  });
});
