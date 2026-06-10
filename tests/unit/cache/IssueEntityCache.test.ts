// ── Mock ioredis ─────────────────────────────────────────────────────────────
const mockGet   = jest.fn();
const mockSetex = jest.fn();
const mockDel   = jest.fn();
const mockMget  = jest.fn();

jest.mock('../../../src/config/redis', () => ({
  redis:    { get: mockGet, setex: mockSetex, del: mockDel, mget: mockMget },
  redisSub: {},
}));

import { IssueEntityCache } from '../../../src/infrastructure/cache/IssueEntityCache';
import { CacheKeys }        from '../../../src/infrastructure/cache/CacheKeys';
import { CACHE_TTL }        from '../../../src/infrastructure/cache/constants';

// Use plain string for createdAt — JSON round-trip converts Date to ISO string
const ISSUE = { id: 'issue-1', title: 'Fix login', createdAt: '2025-01-01T00:00:00.000Z' } as any;

describe('IssueEntityCache', () => {
  let cache: IssueEntityCache;

  beforeEach(() => {
    cache = new IssueEntityCache();
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('returns parsed issue on cache hit', async () => {
      mockGet.mockResolvedValue(JSON.stringify(ISSUE));
      const result = await cache.get(ISSUE.id);
      expect(result).toEqual(ISSUE);
      expect(mockGet).toHaveBeenCalledWith(CacheKeys.issueEntity(ISSUE.id));
    });

    it('returns null on cache miss', async () => {
      mockGet.mockResolvedValue(null);
      expect(await cache.get(ISSUE.id)).toBeNull();
    });
  });

  describe('set', () => {
    it('serialises to JSON and stores with correct TTL', async () => {
      mockSetex.mockResolvedValue('OK');
      await cache.set(ISSUE);
      expect(mockSetex).toHaveBeenCalledWith(
        CacheKeys.issueEntity(ISSUE.id),
        CACHE_TTL.ISSUE_ENTITY_SECONDS,
        JSON.stringify(ISSUE),
      );
    });
  });

  describe('del', () => {
    it('deletes the issue entity key', async () => {
      mockDel.mockResolvedValue(1);
      await cache.del(ISSUE.id);
      expect(mockDel).toHaveBeenCalledWith(CacheKeys.issueEntity(ISSUE.id));
    });
  });

  describe('mget', () => {
    it('returns empty array for empty input', async () => {
      expect(await cache.mget([])).toEqual([]);
      expect(mockMget).not.toHaveBeenCalled();
    });

    it('requests the correct keys and parses hits', async () => {
      const issue2 = { ...ISSUE, id: 'issue-2' };
      mockMget.mockResolvedValue([JSON.stringify(ISSUE), null, JSON.stringify(issue2)]);
      const result = await cache.mget(['issue-1', 'issue-missing', 'issue-2']);
      expect(result).toEqual([ISSUE, null, issue2]);
      expect(mockMget).toHaveBeenCalledWith(
        CacheKeys.issueEntity('issue-1'),
        CacheKeys.issueEntity('issue-missing'),
        CacheKeys.issueEntity('issue-2'),
      );
    });
  });
});
