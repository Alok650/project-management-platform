import { ProjectRole } from '../../../src/core/types/enums';

// ── Mock ioredis before any module import touches it ────────────────────────
const mockGet    = jest.fn();
const mockSetex  = jest.fn();
const mockDel    = jest.fn();

jest.mock('../../../src/config/redis', () => ({
  redis:    { get: mockGet, setex: mockSetex, del: mockDel },
  redisSub: {},
}));

import { MembershipCache } from '../../../src/infrastructure/cache/MembershipCache';
import { CacheKeys }       from '../../../src/infrastructure/cache/CacheKeys';
import { CACHE_TTL }       from '../../../src/infrastructure/cache/constants';

const PROJECT_ID = 'proj-1';
const USER_ID    = 'user-1';
const ROLE       = ProjectRole.MEMBER;

describe('MembershipCache', () => {
  let cache: MembershipCache;

  beforeEach(() => {
    cache = new MembershipCache();
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('returns parsed role on cache hit', async () => {
      mockGet.mockResolvedValue(ROLE);
      const result = await cache.get(PROJECT_ID, USER_ID);
      expect(result).toBe(ROLE);
      expect(mockGet).toHaveBeenCalledWith(CacheKeys.membershipRole(PROJECT_ID, USER_ID));
    });

    it('returns null on cache miss', async () => {
      mockGet.mockResolvedValue(null);
      expect(await cache.get(PROJECT_ID, USER_ID)).toBeNull();
    });
  });

  describe('set', () => {
    it('calls setex with correct key, TTL, and role value', async () => {
      mockSetex.mockResolvedValue('OK');
      await cache.set(PROJECT_ID, USER_ID, ROLE);
      expect(mockSetex).toHaveBeenCalledWith(
        CacheKeys.membershipRole(PROJECT_ID, USER_ID),
        CACHE_TTL.MEMBERSHIP_SECONDS,
        ROLE,
      );
    });
  });

  describe('del', () => {
    it('deletes the membership key', async () => {
      mockDel.mockResolvedValue(1);
      await cache.del(PROJECT_ID, USER_ID);
      expect(mockDel).toHaveBeenCalledWith(CacheKeys.membershipRole(PROJECT_ID, USER_ID));
    });
  });

  describe('CacheKeys.membershipRole', () => {
    it('generates distinct keys per project+user pair', () => {
      expect(CacheKeys.membershipRole('p1', 'u1')).not.toBe(CacheKeys.membershipRole('p1', 'u2'));
      expect(CacheKeys.membershipRole('p1', 'u1')).not.toBe(CacheKeys.membershipRole('p2', 'u1'));
    });
  });
});
