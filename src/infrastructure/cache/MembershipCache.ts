import { redis } from '../../config/redis';
import { CacheKeys } from './CacheKeys';
import { CACHE_TTL } from './constants';
import { ProjectRole } from '../../core/types/enums';

/** TTL-backed cache for project membership role lookups (eliminates per-request DB hit in RBAC middleware) */
export class MembershipCache {
  async get(projectId: string, userId: string): Promise<ProjectRole | null> {
    const val = await redis.get(CacheKeys.membershipRole(projectId, userId));
    return (val as ProjectRole) ?? null;
  }

  async set(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await redis.setex(
      CacheKeys.membershipRole(projectId, userId),
      CACHE_TTL.MEMBERSHIP_SECONDS,
      role,
    );
  }

  async del(projectId: string, userId: string): Promise<void> {
    await redis.del(CacheKeys.membershipRole(projectId, userId));
  }
}

export const membershipCache = new MembershipCache();
