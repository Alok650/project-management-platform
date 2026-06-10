/**
 * Unit tests for IssueQueryService
 *
 * All infrastructure (AppDataSource, redisCache, WorkflowRepository) is mocked
 * at the module level so no real database or Redis connections are required.
 */

// ── Module-level mocks ────────────────────────────────────────────────────────

// QueryBuilder mock — every chained method returns `this` so the whole fluent
// chain resolves cleanly; `getMany` is replaced per-test.
const mockGetMany             = jest.fn();
const mockQueryBuilder = {
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where:             jest.fn().mockReturnThis(),
  andWhere:          jest.fn().mockReturnThis(),
  select:            jest.fn().mockReturnThis(),
  orderBy:           jest.fn().mockReturnThis(),
  addOrderBy:        jest.fn().mockReturnThis(),
  limit:             jest.fn().mockReturnThis(),
  getMany:           mockGetMany,
};

const mockGetRepository = jest.fn().mockReturnValue({
  createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
});

jest.mock('../../../src/config/database', () => ({
  AppDataSource: { getRepository: mockGetRepository },
}));

const mockRedisCacheGet = jest.fn();
const mockRedisCacheSet = jest.fn();

jest.mock('../../../src/infrastructure/cache/RedisCache', () => ({
  redisCache: { get: mockRedisCacheGet, set: mockRedisCacheSet },
}));

const mockFindStatusesByProject = jest.fn();

jest.mock('../../../src/modules/workflow/WorkflowRepository', () => ({
  WorkflowRepository: jest.fn().mockImplementation(() => ({
    findStatusesByProject: mockFindStatusesByProject,
  })),
}));

// IssueQueryService now imports IssueEntityCache and IssueIndexCache
jest.mock('../../../src/infrastructure/cache/IssueEntityCache', () => ({
  issueEntityCache: {
    get:  jest.fn().mockResolvedValue(null),
    set:  jest.fn().mockResolvedValue(undefined),
    del:  jest.fn().mockResolvedValue(undefined),
    mget: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../../../src/infrastructure/cache/IssueIndexCache', () => ({
  issueIndexCache: {
    addIssue:             jest.fn().mockResolvedValue(undefined),
    removeIssue:          jest.fn().mockResolvedValue(undefined),
    updateIssueStatus:    jest.fn().mockResolvedValue(undefined),
    populateFromIssues:   jest.fn().mockResolvedValue(undefined),
    isSprintIndexWarm:    jest.fn().mockResolvedValue(false),
    getStatusIssueIds:    jest.fn().mockResolvedValue(null),
    getSprintIssueIds:    jest.fn().mockResolvedValue(null),
    invalidateSprintIndex: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { IssueQueryService }  from '../../../src/modules/issues/IssueQueryService';
import { IssueRepository }    from '../../../src/modules/issues/IssueRepository';
import { NotFoundError }      from '../../../src/core/errors/errors';
import { encodeCursor, decodeCursor } from '../../../src/core/types/Pagination';
import type { BoardView }     from '../../../src/read-models/BoardView';
import type { Issue }         from '../../../src/models/Issue';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'project-uuid-1';
const SPRINT_ID  = 'sprint-uuid-1';

function makeStatus(id: string, name: string, position: number) {
  return { id, name, category: 'TODO', position, wipLimit: null, projectId: PROJECT_ID };
}

const STATUS_TODO        = makeStatus('status-1', 'To Do',       1);
const STATUS_IN_PROGRESS = makeStatus('status-2', 'In Progress', 2);
const STATUS_DONE        = makeStatus('status-3', 'Done',        3);

function makeIssue(id: string, statusId: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    issueKey:    `PROJ-${id}`,
    type:        'STORY',
    title:       `Issue ${id}`,
    priority:    'MEDIUM',
    storyPoints: null,
    statusId,
    parentId:    null,
    labels:      [],
    version:     1,
    assignee:    null,
    projectId:   PROJECT_ID,
    sprintId:    SPRINT_ID,
    createdAt:   new Date('2024-01-01T00:00:00.000Z'),
    updatedAt:   new Date('2024-01-01T00:00:00.000Z'),
    deletedAt:   null,
    ...overrides,
  } as unknown as Issue;
}

// 4 issues spread across 3 statuses (2 in TODO, 1 in IN_PROGRESS, 1 in DONE)
const MOCK_ISSUES = [
  makeIssue('i1', STATUS_TODO.id),
  makeIssue('i2', STATUS_TODO.id),
  makeIssue('i3', STATUS_IN_PROGRESS.id),
  makeIssue('i4', STATUS_DONE.id),
];

function makeIssueRepoMock(): jest.Mocked<IssueRepository> {
  return {
    findById:    jest.fn(),
    findByKey:   jest.fn(),
    save:        jest.fn(),
    softDelete:  jest.fn(),
    addWatcher:  jest.fn(),
    removeWatcher: jest.fn(),
    getWatchers: jest.fn(),
  } as unknown as jest.Mocked<IssueRepository>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reset every shared mock before each test */
function resetAllMocks() {
  mockGetMany.mockReset();
  mockRedisCacheGet.mockReset();
  mockRedisCacheSet.mockResolvedValue(undefined);
  mockFindStatusesByProject.mockReset();
  mockQueryBuilder.leftJoinAndSelect.mockClear();
  mockQueryBuilder.where.mockClear();
  mockQueryBuilder.andWhere.mockClear();
  mockQueryBuilder.select.mockClear();
  mockQueryBuilder.orderBy.mockClear();
  mockQueryBuilder.addOrderBy.mockClear();
  mockQueryBuilder.limit.mockClear();
  // Restore the chaining (mockClear resets calls but not implementation)
  mockQueryBuilder.leftJoinAndSelect.mockReturnThis();
  mockQueryBuilder.where.mockReturnThis();
  mockQueryBuilder.andWhere.mockReturnThis();
  mockQueryBuilder.select.mockReturnThis();
  mockQueryBuilder.orderBy.mockReturnThis();
  mockQueryBuilder.addOrderBy.mockReturnThis();
  mockQueryBuilder.limit.mockReturnThis();
  mockGetRepository.mockReturnValue({
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IssueQueryService', () => {
  let issueRepo: jest.Mocked<IssueRepository>;
  let service: IssueQueryService;

  beforeEach(() => {
    resetAllMocks();
    issueRepo = makeIssueRepoMock();
    service   = new IssueQueryService(issueRepo);
  });

  // ── getBoardView ─────────────────────────────────────────────────────────────

  describe('getBoardView', () => {
    describe('cache hit', () => {
      it('returns the cached BoardView immediately without hitting the DB', async () => {
        const cachedBoard: BoardView = {
          projectId: PROJECT_ID,
          sprintId:  SPRINT_ID,
          cachedAt:  '2024-01-01T00:00:00.000Z',
          columns:   [],
        };
        mockRedisCacheGet.mockResolvedValue(cachedBoard);

        const result = await service.getBoardView(PROJECT_ID, SPRINT_ID);

        expect(result).toBe(cachedBoard);
        expect(mockGetRepository).not.toHaveBeenCalled();
      });
    });

    describe('cache miss', () => {
      beforeEach(() => {
        mockRedisCacheGet.mockResolvedValue(null);
        mockFindStatusesByProject.mockResolvedValue([
          STATUS_TODO, STATUS_IN_PROGRESS, STATUS_DONE,
        ]);
        mockGetMany.mockResolvedValue(MOCK_ISSUES);
      });

      it('returns a BoardView with 3 columns', async () => {
        const result = await service.getBoardView(PROJECT_ID, SPRINT_ID);

        expect(result.columns).toHaveLength(3);
      });

      it('groups issues into the correct column by statusId', async () => {
        const result = await service.getBoardView(PROJECT_ID, SPRINT_ID);

        const todoCol        = result.columns.find(c => c.statusId === STATUS_TODO.id)!;
        const inProgressCol  = result.columns.find(c => c.statusId === STATUS_IN_PROGRESS.id)!;
        const doneCol        = result.columns.find(c => c.statusId === STATUS_DONE.id)!;

        expect(todoCol.issues).toHaveLength(2);
        expect(todoCol.issues.map(i => i.id)).toEqual(
          expect.arrayContaining(['i1', 'i2']),
        );
        expect(inProgressCol.issues).toHaveLength(1);
        expect(inProgressCol.issues[0]!.id).toBe('i3');
        expect(doneCol.issues).toHaveLength(1);
        expect(doneCol.issues[0]!.id).toBe('i4');
      });

      it('calls redisCache.set with the sprint-keyed board key and 5-min TTL', async () => {
        await service.getBoardView(PROJECT_ID, SPRINT_ID);

        expect(mockRedisCacheSet).toHaveBeenCalledWith(
          `board:${PROJECT_ID}:sprint:${SPRINT_ID}`,
          expect.objectContaining({ projectId: PROJECT_ID }),
          300,
        );
      });
    });

    describe('sprint filter', () => {
      beforeEach(() => {
        mockRedisCacheGet.mockResolvedValue(null);
        mockFindStatusesByProject.mockResolvedValue([STATUS_TODO]);
        mockGetMany.mockResolvedValue([]);
      });

      it('includes sprintId in the andWhere call when sprintId is provided', async () => {
        await service.getBoardView(PROJECT_ID, SPRINT_ID);

        // Find the andWhere call that carries the sprint condition
        const sprintCall = mockQueryBuilder.andWhere.mock.calls.find(
          ([clause]: [string]) => typeof clause === 'string' && clause.includes('sprintId'),
        );
        expect(sprintCall).toBeDefined();
        expect(sprintCall![1]).toMatchObject({ sprintId: SPRINT_ID });
      });
    });

    describe('backlog (sprintId null)', () => {
      beforeEach(() => {
        mockRedisCacheGet.mockResolvedValue(null);
        mockFindStatusesByProject.mockResolvedValue([STATUS_TODO]);
        mockGetMany.mockResolvedValue([]);
      });

      it('uses IS NULL condition when sprintId is null', async () => {
        await service.getBoardView(PROJECT_ID, null);

        const nullCall = mockQueryBuilder.andWhere.mock.calls.find(
          ([clause]: [string]) => typeof clause === 'string' && clause.includes('IS NULL'),
        );
        expect(nullCall).toBeDefined();
      });
    });
  });

  // ── getById ──────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns the issue when found', async () => {
      const issue = makeIssue('i1', STATUS_TODO.id);
      issueRepo.findById.mockResolvedValue(issue);

      const result = await service.getById('i1');

      expect(result).toBe(issue);
      expect(issueRepo.findById).toHaveBeenCalledWith(
        'i1',
        ['status', 'assignee', 'reporter', 'sprint', 'parent'],
      );
    });

    it('throws NotFoundError when the issue does not exist', async () => {
      issueRepo.findById.mockResolvedValue(null);

      await expect(service.getById('missing-id')).rejects.toThrow(NotFoundError);
      await expect(service.getById('missing-id')).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  // ── list (cursor pagination) ─────────────────────────────────────────────────

  describe('list', () => {
    const LIMIT = 3;

    function makeIssueWithDate(id: string, createdAt: Date): Issue {
      return makeIssue(id, STATUS_TODO.id, { createdAt });
    }

    describe('more pages exist (limit + 1 rows returned)', () => {
      it('sets hasMore=true, trims items to limit, and returns a non-null nextCursor', async () => {
        const rows = [
          makeIssueWithDate('i1', new Date('2024-01-04T00:00:00.000Z')),
          makeIssueWithDate('i2', new Date('2024-01-03T00:00:00.000Z')),
          makeIssueWithDate('i3', new Date('2024-01-02T00:00:00.000Z')),
          makeIssueWithDate('i4', new Date('2024-01-01T00:00:00.000Z')), // extra row
        ];
        mockGetMany.mockResolvedValue(rows);

        const result = await service.list(PROJECT_ID, {}, { limit: LIMIT });

        expect(result.hasMore).toBe(true);
        expect(result.items).toHaveLength(LIMIT);
        expect(result.nextCursor).not.toBeNull();
      });

      it('encodes nextCursor as base64url in {isoDate}__{id} format', async () => {
        const lastDate = new Date('2024-01-02T00:00:00.000Z');
        const rows = [
          makeIssueWithDate('i1', new Date('2024-01-04T00:00:00.000Z')),
          makeIssueWithDate('i2', new Date('2024-01-03T00:00:00.000Z')),
          makeIssueWithDate('i3', lastDate), // this is the last item included
          makeIssueWithDate('i4', new Date('2024-01-01T00:00:00.000Z')), // triggers hasMore
        ];
        mockGetMany.mockResolvedValue(rows);

        const result = await service.list(PROJECT_ID, {}, { limit: LIMIT });

        expect(result.nextCursor).not.toBeNull();

        const decoded = decodeCursor(result.nextCursor!);
        // Must match pattern: <isoDate>__<id>
        expect(decoded).toMatch(/^[\d-T:.Z]+__[a-z0-9-]+$/);

        const separatorIdx = decoded.lastIndexOf('__');
        const isoDate = decoded.slice(0, separatorIdx);
        const id      = decoded.slice(separatorIdx + 2);

        expect(isoDate).toBe(lastDate.toISOString());
        expect(id).toBe('i3');
      });
    });

    describe('last page (exactly limit rows returned)', () => {
      it('sets hasMore=false and nextCursor=null', async () => {
        const rows = [
          makeIssueWithDate('i1', new Date('2024-01-03T00:00:00.000Z')),
          makeIssueWithDate('i2', new Date('2024-01-02T00:00:00.000Z')),
          makeIssueWithDate('i3', new Date('2024-01-01T00:00:00.000Z')),
        ];
        mockGetMany.mockResolvedValue(rows);

        const result = await service.list(PROJECT_ID, {}, { limit: LIMIT });

        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
        expect(result.items).toHaveLength(LIMIT);
      });
    });
  });
});
