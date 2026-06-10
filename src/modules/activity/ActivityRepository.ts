import { AppDataSource } from '../../config/database';
import { ActivityLog } from '../../models/ActivityLog';
import type { CursorPage } from '../../core/types/Pagination';
import { encodeCursor, decodeCursor } from '../../core/types/Pagination';

/** Data access layer for ActivityLog entries */
export class ActivityRepository {
  private readonly repo = AppDataSource.getRepository(ActivityLog);

  /** Persist a new activity log entry */
  save(data: Partial<ActivityLog>): Promise<ActivityLog> {
    return this.repo.save(data);
  }

  /**
   * Cursor-paginated activity feed for a project.
   * Supports optional filters for entityType, entityId, and actorId.
   *
   * @param projectId - Project scope
   * @param filters - Optional narrowing filters
   * @param cursor - Opaque pagination cursor
   * @param limit - Max items per page
   */
  async listByProject(
    projectId: string,
    filters: { entityType?: string; entityId?: string; actorId?: string },
    cursor?: string,
    limit = 50,
  ): Promise<CursorPage<ActivityLog>> {
    const qb = this.repo.createQueryBuilder('a')
      .leftJoinAndSelect('a.actor', 'actor')
      .where('a.projectId = :projectId', { projectId })
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .limit(limit + 1);

    if (filters.entityType) qb.andWhere('a.entityType = :entityType', { entityType: filters.entityType });
    if (filters.entityId)   qb.andWhere('a.entityId = :entityId',   { entityId: filters.entityId });
    if (filters.actorId)    qb.andWhere('a.actorId = :actorId',     { actorId: filters.actorId });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const separatorIndex = decoded.lastIndexOf('__');
      const cursorDate = decoded.slice(0, separatorIndex);
      const cursorId   = decoded.slice(separatorIndex + 2);
      qb.andWhere(
        '(a.createdAt < :cursorDate OR (a.createdAt = :cursorDate AND a.id < :cursorId))',
        { cursorDate, cursorId },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, -1) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(`${last.createdAt.toISOString()}__${last.id}`) : null;
    return { items, nextCursor, hasMore };
  }
}
