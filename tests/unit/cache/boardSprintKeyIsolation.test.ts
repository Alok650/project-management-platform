/**
 * Verifies that IssueQueryService.getBoardView uses a per-sprint cache key,
 * preventing sprint A board data from contaminating sprint B cache entries.
 *
 * This is a regression test for the bug where CacheKeys.boardState only
 * accepted projectId, causing all sprints in a project to share one cache entry.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRedisGet  = jest.fn();
const mockRedisSetex = jest.fn().mockResolvedValue('OK');
const mockRedisScan = jest.fn();

jest.mock('../../../src/config/redis', () => ({
  redis: {
    get:    (...a: unknown[]) => mockRedisGet(...a),
    setex:  (...a: unknown[]) => mockRedisSetex(...a),
    scan:   (...a: unknown[]) => mockRedisScan(...a),
    del:    jest.fn(),
    zadd:   jest.fn(),
    zrem:   jest.fn(),
    expire: jest.fn(),
    pipeline: jest.fn().mockReturnValue({
      zadd:   jest.fn().mockReturnThis(),
      zrem:   jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec:   jest.fn().mockResolvedValue([]),
    }),
    exists: jest.fn().mockResolvedValue(0),
  },
  redisSub: {},
}));

// Stub AppDataSource — board query uses createQueryBuilder
const mockGetMany   = jest.fn().mockResolvedValue([]);
const mockQb = {
  leftJoinAndSelect: jest.fn().mockReturnThis(),
  where:             jest.fn().mockReturnThis(),
  andWhere:          jest.fn().mockReturnThis(),
  select:            jest.fn().mockReturnThis(),
  orderBy:           jest.fn().mockReturnThis(),
  addOrderBy:        jest.fn().mockReturnThis(),
  limit:             jest.fn().mockReturnThis(),
  getMany:           mockGetMany,
};
const mockCreateQueryBuilder = jest.fn().mockReturnValue(mockQb);

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn().mockReturnValue({ createQueryBuilder: mockCreateQueryBuilder }),
    transaction:   jest.fn(),
  },
}));

// WorkflowRepository — returns a minimal status list so board builds succeed
jest.mock('../../../src/modules/workflow/WorkflowRepository', () => ({
  WorkflowRepository: jest.fn().mockImplementation(() => ({
    findStatusesByProject: jest.fn().mockResolvedValue([
      { id: 'status-todo', name: 'To Do', category: 'TODO', position: 0, wipLimit: null },
    ]),
  })),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { IssueQueryService } from '../../../src/modules/issues/IssueQueryService';
import { IssueRepository }   from '../../../src/modules/issues/IssueRepository';
import { CacheKeys }          from '../../../src/infrastructure/cache/CacheKeys';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IssueQueryService.getBoardView — sprint cache key isolation', () => {
  let svc: IssueQueryService;

  beforeEach(() => {
    svc = new IssueQueryService({} as IssueRepository);
    jest.clearAllMocks();
    mockGetMany.mockResolvedValue([]);
    mockRedisGet.mockResolvedValue(null); // always cache miss
  });

  it('sprint A and sprint B produce different board cache keys', () => {
    const keyA = CacheKeys.boardState('proj-1', 'sprint-a');
    const keyB = CacheKeys.boardState('proj-1', 'sprint-b');
    expect(keyA).not.toBe(keyB);
  });

  it('null sprint (backlog) has its own distinct cache key', () => {
    const backlogKey = CacheKeys.boardState('proj-1', null);
    const sprintKey  = CacheKeys.boardState('proj-1', 'sprint-1');
    expect(backlogKey).toBe('board:proj-1:sprint:backlog');
    expect(backlogKey).not.toBe(sprintKey);
  });

  it('same sprintId always produces the same key (stable lookups)', () => {
    expect(CacheKeys.boardState('proj-1', 'sprint-x'))
      .toBe(CacheKeys.boardState('proj-1', 'sprint-x'));
  });

  it('getBoardView stores result under sprint-keyed cache key', async () => {
    await svc.getBoardView('proj-1', 'sprint-a');

    const expectedKey = CacheKeys.boardState('proj-1', 'sprint-a');
    expect(mockRedisGet).toHaveBeenCalledWith(expectedKey);
    expect(mockRedisSetex).toHaveBeenCalledWith(
      expectedKey,
      expect.any(Number),
      expect.any(String),
    );
  });

  it('sprint A and sprint B lookups use separate cache slots', async () => {
    await svc.getBoardView('proj-1', 'sprint-a');
    await svc.getBoardView('proj-1', 'sprint-b');

    const getCalls = mockRedisGet.mock.calls.map(([k]) => k as string);
    const keyA = CacheKeys.boardState('proj-1', 'sprint-a');
    const keyB = CacheKeys.boardState('proj-1', 'sprint-b');
    expect(getCalls).toContain(keyA);
    expect(getCalls).toContain(keyB);
    expect(keyA).not.toBe(keyB);
  });

  it('returns cached board without querying the DB', async () => {
    const cachedBoard = {
      projectId: 'proj-1', sprintId: 'sprint-a',
      cachedAt: new Date().toISOString(), columns: [],
    };
    mockRedisGet.mockResolvedValue(JSON.stringify(cachedBoard));

    const result = await svc.getBoardView('proj-1', 'sprint-a');

    expect(result).toEqual(cachedBoard);
    expect(mockGetMany).not.toHaveBeenCalled();
  });
});
