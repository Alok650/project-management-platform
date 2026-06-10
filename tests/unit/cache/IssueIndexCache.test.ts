// ── Mock ioredis ─────────────────────────────────────────────────────────────
const mockExec           = jest.fn().mockResolvedValue([]);
const mockPipeline       = jest.fn();
const mockExists         = jest.fn();
const mockZrevrange      = jest.fn();
const mockZrevrangebyscore = jest.fn();

const pipelineStub = {
  zadd:   jest.fn().mockReturnThis(),
  zrem:   jest.fn().mockReturnThis(),
  expire: jest.fn().mockReturnThis(),
  exec:   mockExec,
};

mockPipeline.mockReturnValue(pipelineStub);

jest.mock('../../../src/config/redis', () => ({
  redis: {
    pipeline:        mockPipeline,
    exists:          mockExists,
    zrevrange:       mockZrevrange,
    zrevrangebyscore: mockZrevrangebyscore,
    del:             jest.fn().mockResolvedValue(1),
  },
  redisSub: {},
}));

import { IssueIndexCache }  from '../../../src/infrastructure/cache/IssueIndexCache';
import { CacheKeys }        from '../../../src/infrastructure/cache/CacheKeys';

const PROJECT_ID  = 'proj-1';
const SPRINT_ID   = 'sprint-1';
const STATUS_ID   = 'status-1';
const STATUS_ID_2 = 'status-2';
const ISSUE_ID    = 'issue-abc';

const ISSUE = {
  id:        ISSUE_ID,
  projectId: PROJECT_ID,
  sprintId:  SPRINT_ID,
  statusId:  STATUS_ID,
  createdAt: new Date('2025-03-01T10:00:00Z'),
} as any;

describe('IssueIndexCache', () => {
  let cache: IssueIndexCache;

  beforeEach(() => {
    cache = new IssueIndexCache();
    jest.clearAllMocks();
    mockPipeline.mockReturnValue(pipelineStub);
    pipelineStub.zadd.mockReturnThis();
    pipelineStub.zrem.mockReturnThis();
    pipelineStub.expire.mockReturnThis();
    mockExec.mockResolvedValue([]);
  });

  // ── CacheKeys — key generation ────────────────────────────────────────────

  describe('CacheKeys — board key isolation', () => {
    it('boardState generates distinct keys for different sprints', () => {
      const keyA = CacheKeys.boardState('p', 'sprint-a');
      const keyB = CacheKeys.boardState('p', 'sprint-b');
      expect(keyA).not.toBe(keyB);
    });

    it('boardState uses backlog sentinel for null sprint', () => {
      expect(CacheKeys.boardState('p', null)).toBe('board:p:sprint:backlog');
    });

    it('boardState is deterministic for same inputs', () => {
      expect(CacheKeys.boardState('p', 'sprint-a')).toBe(CacheKeys.boardState('p', 'sprint-a'));
    });

    it('boardStatePattern returns glob covering all sprint keys for project', () => {
      expect(CacheKeys.boardStatePattern('p')).toBe('board:p:sprint:*');
    });
  });

  // ── addIssue ─────────────────────────────────────────────────────────────

  describe('addIssue', () => {
    it('adds issue to sprint and status sorted sets with createdAt as score', async () => {
      await cache.addIssue(ISSUE);
      const score = ISSUE.createdAt.getTime();
      expect(pipelineStub.zadd).toHaveBeenCalledWith(
        CacheKeys.sprintIssueIndex(PROJECT_ID, SPRINT_ID), score, ISSUE_ID,
      );
      expect(pipelineStub.zadd).toHaveBeenCalledWith(
        CacheKeys.statusIssueIndex(PROJECT_ID, STATUS_ID), score, ISSUE_ID,
      );
      expect(mockExec).toHaveBeenCalled();
    });

    it('uses backlog key when sprintId is null', async () => {
      await cache.addIssue({ ...ISSUE, sprintId: null });
      expect(pipelineStub.zadd).toHaveBeenCalledWith(
        CacheKeys.sprintIssueIndex(PROJECT_ID, null),
        expect.any(Number),
        ISSUE_ID,
      );
    });
  });

  // ── removeIssue ───────────────────────────────────────────────────────────

  describe('removeIssue', () => {
    it('removes issue from sprint and status sets', async () => {
      await cache.removeIssue(ISSUE);
      expect(pipelineStub.zrem).toHaveBeenCalledWith(
        CacheKeys.sprintIssueIndex(PROJECT_ID, SPRINT_ID), ISSUE_ID,
      );
      expect(pipelineStub.zrem).toHaveBeenCalledWith(
        CacheKeys.statusIssueIndex(PROJECT_ID, STATUS_ID), ISSUE_ID,
      );
    });
  });

  // ── updateIssueStatus ─────────────────────────────────────────────────────

  describe('updateIssueStatus', () => {
    it('removes from old status and adds to new status in one pipeline', async () => {
      const score = Date.now();
      await cache.updateIssueStatus(PROJECT_ID, ISSUE_ID, STATUS_ID, STATUS_ID_2, score);
      expect(pipelineStub.zrem).toHaveBeenCalledWith(
        CacheKeys.statusIssueIndex(PROJECT_ID, STATUS_ID), ISSUE_ID,
      );
      expect(pipelineStub.zadd).toHaveBeenCalledWith(
        CacheKeys.statusIssueIndex(PROJECT_ID, STATUS_ID_2), score, ISSUE_ID,
      );
    });
  });

  // ── populateFromIssues ────────────────────────────────────────────────────

  describe('populateFromIssues', () => {
    it('is a no-op for empty list', async () => {
      await cache.populateFromIssues(PROJECT_ID, SPRINT_ID, []);
      expect(mockPipeline).not.toHaveBeenCalled();
    });

    it('pipelines ZADD for each issue and sets expire on sprint key', async () => {
      const issues = [
        { id: 'i1', createdAt: new Date('2025-01-01'), statusId: STATUS_ID },
        { id: 'i2', createdAt: new Date('2025-01-02'), statusId: STATUS_ID_2 },
      ] as any[];

      await cache.populateFromIssues(PROJECT_ID, SPRINT_ID, issues);

      expect(pipelineStub.zadd).toHaveBeenCalledTimes(4); // 2 sprint + 2 status
      expect(pipelineStub.expire).toHaveBeenCalledWith(
        CacheKeys.sprintIssueIndex(PROJECT_ID, SPRINT_ID),
        expect.any(Number),
      );
      expect(mockExec).toHaveBeenCalled();
    });
  });

  // ── isSprintIndexWarm ─────────────────────────────────────────────────────

  describe('isSprintIndexWarm', () => {
    it('returns true when key exists', async () => {
      mockExists.mockResolvedValue(1);
      expect(await cache.isSprintIndexWarm(PROJECT_ID, SPRINT_ID)).toBe(true);
    });

    it('returns false when key does not exist', async () => {
      mockExists.mockResolvedValue(0);
      expect(await cache.isSprintIndexWarm(PROJECT_ID, SPRINT_ID)).toBe(false);
    });
  });

  // ── getStatusIssueIds ─────────────────────────────────────────────────────

  describe('getStatusIssueIds', () => {
    it('returns null when index is cold', async () => {
      mockExists.mockResolvedValue(0);
      expect(await cache.getStatusIssueIds(PROJECT_ID, STATUS_ID)).toBeNull();
    });

    it('returns sorted IDs when index is warm', async () => {
      mockExists.mockResolvedValue(1);
      mockZrevrange.mockResolvedValue(['i3', 'i2', 'i1']);
      const ids = await cache.getStatusIssueIds(PROJECT_ID, STATUS_ID);
      expect(ids).toEqual(['i3', 'i2', 'i1']);
      expect(mockZrevrange).toHaveBeenCalledWith(
        CacheKeys.statusIssueIndex(PROJECT_ID, STATUS_ID), 0, -1,
      );
    });
  });

  // ── getSprintIssueIds ─────────────────────────────────────────────────────

  describe('getSprintIssueIds', () => {
    it('returns null when sprint index is cold', async () => {
      mockExists.mockResolvedValue(0);
      expect(await cache.getSprintIssueIds(PROJECT_ID, SPRINT_ID, undefined, 10)).toBeNull();
    });

    it('returns first page from ZREVRANGE and hasMore=false when under limit', async () => {
      mockExists.mockResolvedValue(1);
      mockZrevrange.mockResolvedValue(['i2', 'i1']); // 2 items, limit 10 → no more
      const result = await cache.getSprintIssueIds(PROJECT_ID, SPRINT_ID, undefined, 10);
      expect(result).toEqual({ ids: ['i2', 'i1'], hasMore: false });
    });

    it('truncates to limit and sets hasMore=true when extra item returned', async () => {
      mockExists.mockResolvedValue(1);
      // limit=2 → request limit+1=3 items; return 3 → hasMore=true
      mockZrevrange.mockResolvedValue(['i3', 'i2', 'i1']);
      const result = await cache.getSprintIssueIds(PROJECT_ID, SPRINT_ID, undefined, 2);
      expect(result).toEqual({ ids: ['i3', 'i2'], hasMore: true });
    });

    it('uses ZREVRANGEBYSCORE with exclusive upper bound when cursor provided', async () => {
      mockExists.mockResolvedValue(1);
      mockZrevrangebyscore.mockResolvedValue(['i1']);
      const score = 1700000000000;
      const cursor = Buffer.from(`${score}__some-id`, 'utf8').toString('base64url');
      await cache.getSprintIssueIds(PROJECT_ID, SPRINT_ID, cursor, 10);
      expect(mockZrevrangebyscore).toHaveBeenCalledWith(
        CacheKeys.sprintIssueIndex(PROJECT_ID, SPRINT_ID),
        `(${score}`,
        '-inf',
        'LIMIT',
        0,
        11, // limit + 1
      );
    });
  });
});
