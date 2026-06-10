import { redis } from '../../config/redis';
import { CacheKeys } from './CacheKeys';
import { CACHE_TTL } from './constants';
import type { Issue } from '../../models/Issue';

/**
 * Redis sorted-set reverse indexes for issues.
 *
 * Two index families:
 *   - sprint index:  idx:sprint:{projectId}:{sprintId|backlog}
 *   - status index:  idx:status:{projectId}:{statusId}
 *
 * Score = issue.createdAt (unix ms) — enables stable cursor pagination via ZREVRANGEBYSCORE.
 *
 * Indexes are populated lazily on first board/list miss and maintained
 * write-through on creates, transitions, and deletes.  On update the
 * sprint index is invalidated rather than patched (rebuilds on next access).
 */
export class IssueIndexCache {
  /** Add a newly created issue to both sprint and status indexes */
  async addIssue(issue: Issue): Promise<void> {
    const score = new Date(issue.createdAt).getTime();
    await redis
      .pipeline()
      .zadd(CacheKeys.sprintIssueIndex(issue.projectId, issue.sprintId ?? null), score, issue.id)
      .zadd(CacheKeys.statusIssueIndex(issue.projectId, issue.statusId), score, issue.id)
      .exec();
  }

  /** Remove a deleted issue from its sprint and status indexes */
  async removeIssue(issue: Pick<Issue, 'id' | 'projectId' | 'sprintId' | 'statusId'>): Promise<void> {
    await redis
      .pipeline()
      .zrem(CacheKeys.sprintIssueIndex(issue.projectId, issue.sprintId ?? null), issue.id)
      .zrem(CacheKeys.statusIssueIndex(issue.projectId, issue.statusId), issue.id)
      .exec();
  }

  /**
   * Move an issue between status indexes after a workflow transition.
   * Uses a pipelined ZREM + ZADD so the two operations are sent in one round-trip.
   */
  async updateIssueStatus(
    projectId: string,
    issueId: string,
    fromStatusId: string,
    toStatusId: string,
    score: number,
  ): Promise<void> {
    await redis
      .pipeline()
      .zrem(CacheKeys.statusIssueIndex(projectId, fromStatusId), issueId)
      .zadd(CacheKeys.statusIssueIndex(projectId, toStatusId), score, issueId)
      .exec();
  }

  /**
   * Bulk-populate sprint + status indexes from a DB result set.
   * Called during board/list cache-miss so subsequent requests hit Redis.
   * Expires the sprint index after INDEX_SECONDS so stale sets don't accumulate.
   */
  async populateFromIssues(
    projectId: string,
    sprintId: string | null,
    issues: ReadonlyArray<Pick<Issue, 'id' | 'createdAt' | 'statusId'>>,
  ): Promise<void> {
    if (!issues.length) return;
    const sprintKey = CacheKeys.sprintIssueIndex(projectId, sprintId);
    const pipeline  = redis.pipeline();

    for (const issue of issues) {
      const score = new Date(issue.createdAt).getTime();
      pipeline.zadd(sprintKey, score, issue.id);
      pipeline.zadd(CacheKeys.statusIssueIndex(projectId, issue.statusId), score, issue.id);
    }

    pipeline.expire(sprintKey, CACHE_TTL.INDEX_SECONDS);
    await pipeline.exec();
  }

  /** True if the sprint index exists (i.e. has been populated) */
  async isSprintIndexWarm(projectId: string, sprintId: string | null): Promise<boolean> {
    return (await redis.exists(CacheKeys.sprintIssueIndex(projectId, sprintId))) === 1;
  }

  /**
   * Return all issue IDs for a status column in createdAt DESC order.
   * Returns null on cold index — caller falls back to DB.
   */
  async getStatusIssueIds(projectId: string, statusId: string): Promise<string[] | null> {
    const key = CacheKeys.statusIssueIndex(projectId, statusId);
    if (!(await redis.exists(key))) return null;
    return redis.zrevrange(key, 0, -1);
  }

  /**
   * Cursor-paginated page of issue IDs from a sprint index.
   * Returns null on cold index — caller falls back to DB.
   *
   * Cursor format: base64url of "{score}__{id}".
   */
  async getSprintIssueIds(
    projectId: string,
    sprintId: string | null,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ ids: string[]; hasMore: boolean } | null> {
    const key = CacheKeys.sprintIssueIndex(projectId, sprintId);
    if (!(await redis.exists(key))) return null;

    let ids: string[];
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const sep     = decoded.lastIndexOf('__');
      const maxScore = decoded.slice(0, sep);
      // Exclusive upper bound avoids re-returning the cursor item
      ids = await redis.zrevrangebyscore(key, `(${maxScore}`, '-inf', 'LIMIT', 0, limit + 1);
    } else {
      ids = await redis.zrevrange(key, 0, limit); // limit + 1 items
    }

    const hasMore = ids.length > limit;
    return { ids: hasMore ? ids.slice(0, -1) : ids, hasMore };
  }

  /** Invalidate the sprint index for a project (used when sprint assignments change in bulk) */
  async invalidateSprintIndex(projectId: string, sprintId: string | null): Promise<void> {
    await redis.del(CacheKeys.sprintIssueIndex(projectId, sprintId));
  }
}

export const issueIndexCache = new IssueIndexCache();
