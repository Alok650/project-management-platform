/**
 * Unit tests for SprintService.start() and SprintService.complete()
 *
 * SprintRepository and all infrastructure (AppDataSource, eventBus) are mocked
 * so no real database connections are required.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockEmSave            = jest.fn();
const mockEmQuery           = jest.fn();
const mockEmGetRepository   = jest.fn();
const mockIssueRepoUpdate   = jest.fn();
const mockTransaction       = jest.fn();

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    transaction:   mockTransaction,
    getRepository: mockEmGetRepository,
    query:         jest.fn(),
  },
}));

const mockEventBusPublish = jest.fn();

jest.mock('../../../src/core/events/DomainEventBus', () => ({
  eventBus: { publish: mockEventBusPublish },
}));

// SprintService now imports redisCache — mock it so no real Redis connection is needed
jest.mock('../../../src/infrastructure/cache/RedisCache', () => ({
  redisCache: {
    get:              jest.fn().mockResolvedValue(null),
    set:              jest.fn().mockResolvedValue(undefined),
    del:              jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { SprintService }    from '../../../src/modules/sprints/SprintService';
import { SprintRepository } from '../../../src/modules/sprints/SprintRepository';
import { ConflictError, UnprocessableError, NotFoundError } from '../../../src/core/errors/errors';
import { SprintStatus }     from '../../../src/core/types/enums';
import type { Sprint }      from '../../../src/models/Sprint';
import type { Issue }       from '../../../src/models/Issue';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id:        'sprint-1',
    projectId: 'project-1',
    name:      'Sprint 1',
    goal:      null,
    status:    SprintStatus.PLANNING,
    startDate: null,
    endDate:   null,
    velocity:  null,
    createdAt: new Date(),
    updatedAt: new Date(),
    project:   undefined as any,
    ...overrides,
  };
}

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return { id, sprintId: 'sprint-1', ...overrides } as Issue;
}

// ── Repository mock factory ────────────────────────────────────────────────────

function makeRepoMock(): jest.Mocked<SprintRepository> {
  return {
    findById:           jest.fn(),
    findByProject:      jest.fn(),
    save:               jest.fn(),
    findActive:         jest.fn(),
    getIncompleteIssues: jest.fn(),
    getVelocity:        jest.fn(),
  } as unknown as jest.Mocked<SprintRepository>;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SprintService', () => {
  let repo: jest.Mocked<SprintRepository>;
  let service: SprintService;

  beforeEach(() => {
    jest.clearAllMocks();

    repo    = makeRepoMock();
    service = new SprintService(repo);

    // Default: transaction immediately calls its callback with an entity-manager stub
    mockTransaction.mockImplementation(async (cb: (em: any) => Promise<any>) =>
      cb({
        save:          mockEmSave,
        query:         mockEmQuery,
        getRepository: () => ({ update: mockIssueRepoUpdate }),
      }),
    );

    // Advisory-lock queries succeed silently by default
    mockEmQuery.mockResolvedValue([]);
  });

  // ── start() ──────────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('transitions a PLANNING sprint to ACTIVE and publishes SprintUpdatedEvent', async () => {
      const planningSprint = makeSprint({ status: SprintStatus.PLANNING });
      const activeSprint   = makeSprint({ status: SprintStatus.ACTIVE, startDate: '2026-06-10' });

      repo.findById.mockResolvedValue(planningSprint);
      repo.findActive.mockResolvedValue(null);          // no active sprint
      mockEmSave.mockResolvedValue(activeSprint);

      const result = await service.start('sprint-1', 'actor-1', 'corr-1');

      expect(result).toBe(activeSprint);
      expect(mockEmSave).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SprintStatus.ACTIVE }),
      );

      expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
      const event = mockEventBusPublish.mock.calls[0]?.[0];
      expect(event).toMatchObject({
        type:    'SprintUpdated',
        payload: { sprintId: 'sprint-1', projectId: 'project-1', actorId: 'actor-1' },
      });
    });

    it('uses provided startDate when already set on sprint', async () => {
      const sprint = makeSprint({ status: SprintStatus.PLANNING, startDate: '2026-05-01' });
      const saved  = makeSprint({ status: SprintStatus.ACTIVE, startDate: '2026-05-01' });

      repo.findById.mockResolvedValue(sprint);
      repo.findActive.mockResolvedValue(null);
      mockEmSave.mockResolvedValue(saved);

      await service.start('sprint-1', 'actor-1', 'corr-1');

      expect(mockEmSave).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ startDate: '2026-05-01' }),
      );
    });

    it('throws ConflictError when the sprint is not in PLANNING state', async () => {
      repo.findById.mockResolvedValue(makeSprint({ status: SprintStatus.ACTIVE }));

      await expect(
        service.start('sprint-1', 'actor-1', 'corr-1'),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(mockEmSave).not.toHaveBeenCalled();
      expect(mockEventBusPublish).not.toHaveBeenCalled();
    });

    it('throws ConflictError when another sprint is already active in the project', async () => {
      const existingActive = makeSprint({ id: 'sprint-0', status: SprintStatus.ACTIVE });

      repo.findById.mockResolvedValue(makeSprint({ status: SprintStatus.PLANNING }));
      repo.findActive.mockResolvedValue(existingActive);

      await expect(
        service.start('sprint-1', 'actor-1', 'corr-1'),
      ).rejects.toBeInstanceOf(ConflictError);

      expect(mockEmSave).not.toHaveBeenCalled();
      expect(mockEventBusPublish).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the sprint does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.start('sprint-999', 'actor-1', 'corr-1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('acquires and releases the advisory lock in all cases', async () => {
      // Success path — lock acquired and released
      const sprint = makeSprint({ status: SprintStatus.PLANNING });
      repo.findById.mockResolvedValue(sprint);
      repo.findActive.mockResolvedValue(null);
      mockEmSave.mockResolvedValue(makeSprint({ status: SprintStatus.ACTIVE }));

      await service.start('sprint-1', 'actor-1', 'corr-1');

      const queryCalls = mockEmQuery.mock.calls.map((c: any[]) => c[0]);
      expect(queryCalls.some((q: string) => q.includes('GET_LOCK'))).toBe(true);
      expect(queryCalls.some((q: string) => q.includes('RELEASE_LOCK'))).toBe(true);
    });
  });

  // ── complete() ───────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('completes an ACTIVE sprint, calculates velocity, and publishes SprintUpdatedEvent', async () => {
      const activeSprint    = makeSprint({ status: SprintStatus.ACTIVE });
      const completedSprint = makeSprint({ status: SprintStatus.COMPLETED, velocity: 42 });

      repo.findById.mockResolvedValue(activeSprint);
      repo.getVelocity.mockResolvedValue(42);
      repo.getIncompleteIssues.mockResolvedValue([]);
      mockEmSave.mockResolvedValue(completedSprint);

      const result = await service.complete('sprint-1', [], undefined, 'actor-1', 'corr-1');

      expect(result.sprint).toBe(completedSprint);
      expect(result.incompleteCount).toBe(0);

      expect(mockEmSave).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SprintStatus.COMPLETED, velocity: 42 }),
      );

      expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
      const event = mockEventBusPublish.mock.calls[0]?.[0];
      expect(event).toMatchObject({
        type:    'SprintUpdated',
        payload: { sprintId: 'sprint-1', projectId: 'project-1', actorId: 'actor-1' },
      });
    });

    it('throws UnprocessableError when trying to complete a non-ACTIVE sprint', async () => {
      repo.findById.mockResolvedValue(makeSprint({ status: SprintStatus.PLANNING }));

      await expect(
        service.complete('sprint-1', [], undefined, 'actor-1', 'corr-1'),
      ).rejects.toBeInstanceOf(UnprocessableError);

      expect(mockEmSave).not.toHaveBeenCalled();
      expect(mockEventBusPublish).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when completing a sprint that does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.complete('sprint-999', [], undefined, 'actor-1', 'corr-1'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('moves carry-over issues to nextSprintId', async () => {
      const activeSprint    = makeSprint({ status: SprintStatus.ACTIVE });
      const completedSprint = makeSprint({ status: SprintStatus.COMPLETED, velocity: 0 });

      const issue1 = makeIssue('issue-1');
      const issue2 = makeIssue('issue-2');

      repo.findById.mockResolvedValue(activeSprint);
      repo.getVelocity.mockResolvedValue(0);
      repo.getIncompleteIssues.mockResolvedValue([issue1, issue2]);
      mockEmSave.mockResolvedValue(completedSprint);
      mockIssueRepoUpdate.mockResolvedValue(undefined);

      const result = await service.complete(
        'sprint-1',
        ['issue-1'],           // only issue-1 is carried over
        'sprint-2',            // next sprint
        'actor-1',
        'corr-1',
      );

      expect(result.incompleteCount).toBe(2);

      // issue-1 → sprint-2
      expect(mockIssueRepoUpdate).toHaveBeenCalledWith(
        { id: 'issue-1' },
        { sprintId: 'sprint-2' },
      );

      // issue-2 → backlog (null)
      expect(mockIssueRepoUpdate).toHaveBeenCalledWith(
        { id: 'issue-2' },
        { sprintId: null },
      );
    });

    it('moves carry-over issues to backlog (null) when nextSprintId is undefined', async () => {
      const activeSprint    = makeSprint({ status: SprintStatus.ACTIVE });
      const completedSprint = makeSprint({ status: SprintStatus.COMPLETED, velocity: 0 });
      const issue1          = makeIssue('issue-1');

      repo.findById.mockResolvedValue(activeSprint);
      repo.getVelocity.mockResolvedValue(0);
      repo.getIncompleteIssues.mockResolvedValue([issue1]);
      mockEmSave.mockResolvedValue(completedSprint);
      mockIssueRepoUpdate.mockResolvedValue(undefined);

      await service.complete('sprint-1', ['issue-1'], undefined, 'actor-1', 'corr-1');

      expect(mockIssueRepoUpdate).toHaveBeenCalledWith(
        { id: 'issue-1' },
        { sprintId: null },      // nextSprintId ?? null  →  null
      );
    });

    it('does not call issue update when there are no incomplete issues', async () => {
      const activeSprint    = makeSprint({ status: SprintStatus.ACTIVE });
      const completedSprint = makeSprint({ status: SprintStatus.COMPLETED, velocity: 20 });

      repo.findById.mockResolvedValue(activeSprint);
      repo.getVelocity.mockResolvedValue(20);
      repo.getIncompleteIssues.mockResolvedValue([]);
      mockEmSave.mockResolvedValue(completedSprint);

      const result = await service.complete('sprint-1', [], undefined, 'actor-1', 'corr-1');

      expect(result.incompleteCount).toBe(0);
      expect(mockIssueRepoUpdate).not.toHaveBeenCalled();
    });

    it('acquires and releases the advisory lock in all cases', async () => {
      const activeSprint    = makeSprint({ status: SprintStatus.ACTIVE });
      const completedSprint = makeSprint({ status: SprintStatus.COMPLETED, velocity: 0 });

      repo.findById.mockResolvedValue(activeSprint);
      repo.getVelocity.mockResolvedValue(0);
      repo.getIncompleteIssues.mockResolvedValue([]);
      mockEmSave.mockResolvedValue(completedSprint);

      await service.complete('sprint-1', [], undefined, 'actor-1', 'corr-1');

      const queryCalls = mockEmQuery.mock.calls.map((c: any[]) => c[0]);
      expect(queryCalls.some((q: string) => q.includes('GET_LOCK'))).toBe(true);
      expect(queryCalls.some((q: string) => q.includes('RELEASE_LOCK'))).toBe(true);
    });
  });
});
