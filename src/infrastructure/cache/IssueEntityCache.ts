import { redis } from '../../config/redis';
import { CacheKeys } from './CacheKeys';
import { CACHE_TTL } from './constants';
import type { Issue } from '../../models/Issue';

/**
 * Short-TTL JSON cache for individual issue entities.
 * Populated by getById reads; invalidated (DEL) on every write so stale data
 * is never served for more than one request cycle.
 */
export class IssueEntityCache {
  async get(issueId: string): Promise<Issue | null> {
    const raw = await redis.get(CacheKeys.issueEntity(issueId));
    return raw ? (JSON.parse(raw) as Issue) : null;
  }

  async set(issue: Issue): Promise<void> {
    await redis.setex(
      CacheKeys.issueEntity(issue.id),
      CACHE_TTL.ISSUE_ENTITY_SECONDS,
      JSON.stringify(issue),
    );
  }

  async del(issueId: string): Promise<void> {
    await redis.del(CacheKeys.issueEntity(issueId));
  }

  /** Fetch multiple issues in a single round-trip; missing entries become null */
  async mget(issueIds: string[]): Promise<(Issue | null)[]> {
    if (!issueIds.length) return [];
    const vals = await redis.mget(...issueIds.map((id) => CacheKeys.issueEntity(id)));
    return vals.map((v) => (v ? (JSON.parse(v) as Issue) : null));
  }
}

export const issueEntityCache = new IssueEntityCache();
