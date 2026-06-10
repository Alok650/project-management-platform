/**
 * Verifies that the requireProjectRole middleware serves the membership role
 * from MembershipCache on cache hits and only falls back to the DB on misses.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRedisGet  = jest.fn();
const mockRedisSetex = jest.fn().mockResolvedValue('OK');

jest.mock('../../../src/config/redis', () => ({
  redis:    { get: mockRedisGet, setex: mockRedisSetex, del: jest.fn() },
  redisSub: {},
}));

const mockFindOne       = jest.fn();
const mockGetRepository = jest.fn().mockReturnValue({ findOne: mockFindOne });

jest.mock('../../../src/config/database', () => ({
  AppDataSource: { getRepository: (...a: unknown[]) => mockGetRepository(...a) },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { requireProjectRole } from '../../../src/core/middleware/rbac';
import { CacheKeys }          from '../../../src/infrastructure/cache/CacheKeys';
import { CACHE_TTL }          from '../../../src/infrastructure/cache/constants';
import { ProjectRole }        from '../../../src/core/types/enums';
import { ForbiddenError }     from '../../../src/core/errors/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID    = '22222222-2222-2222-2222-222222222222';

function makeCtx(projectId = PROJECT_ID, userId = USER_ID) {
  return {
    params: { projectId },
    state:  { user: { id: userId }, projectRole: undefined as ProjectRole | undefined },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('requireProjectRole — MembershipCache integration', () => {
  const next = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    next.mockResolvedValue(undefined);
  });

  it('hits the DB on cache miss and then stores the role in cache', async () => {
    mockRedisGet.mockResolvedValue(null); // cache miss
    mockFindOne.mockResolvedValue({ role: ProjectRole.MEMBER });

    const ctx = makeCtx();
    await requireProjectRole(ProjectRole.VIEWER)(ctx as any, next);

    expect(mockFindOne).toHaveBeenCalledTimes(1);
    expect(mockRedisSetex).toHaveBeenCalledWith(
      CacheKeys.membershipRole(PROJECT_ID, USER_ID),
      CACHE_TTL.MEMBERSHIP_SECONDS,
      ProjectRole.MEMBER,
    );
    expect(next).toHaveBeenCalled();
    expect(ctx.state.projectRole).toBe(ProjectRole.MEMBER);
  });

  it('skips the DB entirely on cache hit', async () => {
    mockRedisGet.mockResolvedValue(ProjectRole.MEMBER); // cache hit

    const ctx = makeCtx();
    await requireProjectRole(ProjectRole.VIEWER)(ctx as any, next);

    expect(mockFindOne).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(ctx.state.projectRole).toBe(ProjectRole.MEMBER);
  });

  it('throws ForbiddenError when cached role is below minRole', async () => {
    mockRedisGet.mockResolvedValue(ProjectRole.VIEWER);

    await expect(
      requireProjectRole(ProjectRole.ADMIN)(makeCtx() as any, next),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(mockFindOne).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError and does NOT cache when DB returns no membership', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFindOne.mockResolvedValue(null); // no membership row

    await expect(
      requireProjectRole(ProjectRole.VIEWER)(makeCtx() as any, next),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(mockRedisSetex).not.toHaveBeenCalled();
  });

  it('the membership cache key includes both projectId and userId', () => {
    // Different users in the same project get separate cache entries
    expect(CacheKeys.membershipRole(PROJECT_ID, 'user-a')).not.toBe(
      CacheKeys.membershipRole(PROJECT_ID, 'user-b'),
    );
    // Different projects for the same user get separate cache entries
    expect(CacheKeys.membershipRole('proj-a', USER_ID)).not.toBe(
      CacheKeys.membershipRole('proj-b', USER_ID),
    );
  });
});
