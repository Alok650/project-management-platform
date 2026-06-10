import { AppDataSource } from '../../config/database';
import { Issue } from '../../models/Issue';
import { WorkflowRepository } from '../workflow/WorkflowRepository';
import { IssueRepository } from './IssueRepository';
import { redisCache } from '../../infrastructure/cache/RedisCache';
import { issueEntityCache } from '../../infrastructure/cache/IssueEntityCache';
import { issueIndexCache } from '../../infrastructure/cache/IssueIndexCache';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { CACHE_TTL } from '../../infrastructure/cache/constants';
import { NotFoundError } from '../../core/errors/errors';
import type { BoardView } from '../../read-models/BoardView';
import type { CursorPage } from '../../core/types/Pagination';
import { encodeCursor, decodeCursor } from '../../core/types/Pagination';
import { groupBy } from 'lodash';

/** CQRS read path: board queries and issue lookups, optimized for read performance */
export class IssueQueryService {
  private readonly workflowRepo = new WorkflowRepository();

  constructor(private readonly issueRepo: IssueRepository) {}

  /**
   * Build and cache the board view for a project+sprint.
   *
   * Cache hierarchy:
   *   1. Board cache (full JSON blob, 5-min TTL) — fastest path.
   *   2. DB fallback — queries issues, then populates the board cache AND
   *      the sprint/status sorted-set indexes so the next board expiry can
   *      be served from the index+entity cache path in a future iteration.
   *
   * Board key includes sprintId so sprint A and sprint B never share a cache entry.
   *
   * @param projectId - Project UUID
   * @param sprintId - Sprint UUID, or null for backlog
   */
  async getBoardView(projectId: string, sprintId: string | null): Promise<BoardView> {
    const cacheKey = CacheKeys.boardState(projectId, sprintId);
    const cached = await redisCache.get<BoardView>(cacheKey);
    if (cached) return cached;

    const [statuses, issues] = await Promise.all([
      this.workflowRepo.findStatusesByProject(projectId),
      AppDataSource.getRepository(Issue)
        .createQueryBuilder('i')
        .leftJoinAndSelect('i.assignee', 'assignee')
        .where('i.projectId = :projectId', { projectId })
        .andWhere(sprintId ? 'i.sprintId = :sprintId' : 'i.sprintId IS NULL', sprintId ? { sprintId } : {})
        .andWhere('i.deletedAt IS NULL')
        .select([
          'i.id', 'i.issueKey', 'i.type', 'i.title', 'i.priority',
          'i.storyPoints', 'i.statusId', 'i.parentId', 'i.labels', 'i.version',
          'i.createdAt',
          'assignee.id', 'assignee.displayName',
        ])
        .getMany(),
    ]);

    // Warm sprint+status sorted-set indexes as a side-effect of DB fetch
    issueIndexCache.populateFromIssues(projectId, sprintId, issues).catch(() => {});

    const byStatus = groupBy(issues, 'statusId');

    const boardView: BoardView = {
      projectId,
      sprintId,
      cachedAt: new Date().toISOString(),
      columns: statuses.map((s) => ({
        statusId:   s.id,
        statusName: s.name,
        category:   s.category,
        position:   s.position,
        wipLimit:   s.wipLimit,
        issues: (byStatus[s.id] ?? []).map((i) => ({
          id:          i.id,
          issueKey:    i.issueKey,
          type:        i.type,
          title:       i.title,
          priority:    i.priority,
          storyPoints: i.storyPoints,
          assignee:    i.assignee ? { id: i.assignee.id, displayName: i.assignee.displayName } : null,
          parentId:    i.parentId,
          labels:      i.labels ?? [],
          version:     i.version,
        })),
      })),
    };

    await redisCache.set(cacheKey, boardView, CACHE_TTL.BOARD_SECONDS);
    return boardView;
  }

  /**
   * Fetch a single issue with full relations for the detail view.
   *
   * Cache hierarchy:
   *   1. Entity cache (60-s TTL, DEL on every write).
   *   2. DB fallback — populates entity cache for subsequent reads.
   *
   * @throws {NotFoundError} If the issue does not exist
   */
  async getById(issueId: string): Promise<Issue> {
    const cached = await issueEntityCache.get(issueId);
    if (cached) return cached;

    const issue = await this.issueRepo.findById(issueId, ['status', 'assignee', 'reporter', 'sprint', 'parent']);
    if (!issue) throw new NotFoundError('Issue', issueId);

    issueEntityCache.set(issue).catch(() => {});
    return issue;
  }

  /**
   * Cursor-paginated list of issues with structured filter support.
   *
   * When sprintId is the only active filter and the sprint sorted-set index is warm,
   * the query uses ZRANGEBYSCORE for ID retrieval then fetches entities in a
   * single IN(...) query — avoiding the cursor/filter computation in MySQL.
   * Falls back to the standard cursor query if the index is cold.
   *
   * @param projectId - Scope to a project
   * @param filters - Optional field filters (status, assignee, type, sprint)
   * @param pagination - Cursor and limit
   */
  async list(
    projectId: string,
    filters: { statusId?: string; assigneeId?: string; type?: string; sprintId?: string | null },
    pagination: { cursor?: string; limit: number },
  ): Promise<CursorPage<Issue>> {
    const sprintOnly =
      filters.sprintId !== undefined &&
      !filters.statusId &&
      !filters.assigneeId &&
      !filters.type;

    if (sprintOnly) {
      const page = await issueIndexCache.getSprintIssueIds(
        projectId,
        filters.sprintId ?? null,
        pagination.cursor,
        pagination.limit,
      );

      if (page) {
        const items = await this.fetchIssuesByIds(page.ids);
        const lastItem = items.at(-1);
        const nextCursor =
          page.hasMore && lastItem
            ? encodeCursor(`${new Date(lastItem.createdAt).getTime()}__${lastItem.id}`)
            : null;
        return { items, nextCursor, hasMore: page.hasMore };
      }
      // Index cold — fall through to DB query which will populate it
    }

    return this.listFromDb(projectId, filters, pagination);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Fetch issues by ID set; serves from entity cache where available */
  private async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    if (!ids.length) return [];

    const cached = await issueEntityCache.mget(ids);
    const missingIds = ids.filter((_, i) => !cached[i]);

    let dbIssues: Issue[] = [];
    if (missingIds.length) {
      dbIssues = await AppDataSource.getRepository(Issue)
        .createQueryBuilder('i')
        .leftJoinAndSelect('i.assignee', 'a')
        .leftJoinAndSelect('i.status', 's')
        .where('i.id IN (:...ids)', { ids: missingIds })
        .andWhere('i.deletedAt IS NULL')
        .getMany();
    }

    // Merge cache hits and DB results in original order
    const byId = new Map(dbIssues.map((i) => [i.id, i]));
    return ids
      .map((id, idx) => (cached[idx] as Issue | null) ?? byId.get(id))
      .filter((i): i is Issue => !!i);
  }

  private async listFromDb(
    projectId: string,
    filters: { statusId?: string; assigneeId?: string; type?: string; sprintId?: string | null },
    pagination: { cursor?: string; limit: number },
  ): Promise<CursorPage<Issue>> {
    const qb = AppDataSource.getRepository(Issue)
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.assignee', 'a')
      .leftJoinAndSelect('i.status', 's')
      .where('i.projectId = :projectId', { projectId })
      .andWhere('i.deletedAt IS NULL')
      .orderBy('i.createdAt', 'DESC')
      .addOrderBy('i.id', 'DESC')
      .limit(pagination.limit + 1);

    if (filters.statusId)   qb.andWhere('i.statusId = :statusId',     { statusId: filters.statusId });
    if (filters.assigneeId) qb.andWhere('i.assigneeId = :assigneeId', { assigneeId: filters.assigneeId });
    if (filters.type)       qb.andWhere('i.type = :type',             { type: filters.type });
    if (filters.sprintId !== undefined) {
      filters.sprintId
        ? qb.andWhere('i.sprintId = :sprintId', { sprintId: filters.sprintId })
        : qb.andWhere('i.sprintId IS NULL');
    }

    if (pagination.cursor) {
      const decoded = decodeCursor(pagination.cursor);
      const separatorIndex = decoded.lastIndexOf('__');
      const cursorDate = decoded.slice(0, separatorIndex);
      const cursorId   = decoded.slice(separatorIndex + 2);
      qb.andWhere(
        '(i.createdAt < :cursorDate OR (i.createdAt = :cursorDate AND i.id < :cursorId))',
        { cursorDate, cursorId },
      );
    }

    const rows    = await qb.getMany();
    const hasMore = rows.length > pagination.limit;
    const items   = hasMore ? rows.slice(0, -1) : rows;
    const lastItem = items.at(-1);
    const nextCursor = hasMore && lastItem
      ? encodeCursor(`${lastItem.createdAt.toISOString()}__${lastItem.id}`)
      : null;

    // Opportunistically warm sprint index when only sprint filter is active
    if (filters.sprintId !== undefined && !filters.statusId && !filters.assigneeId && !filters.type) {
      issueIndexCache.populateFromIssues(projectId, filters.sprintId ?? null, items).catch(() => {});
    }

    return { items, nextCursor, hasMore };
  }
}
