import { AppDataSource } from '../../config/database';
import { encodeCursor, decodeCursor } from '../../core/types/Pagination';
import type { CursorPage } from '../../core/types/Pagination';

/** Result item for a unified search hit */
export interface SearchHit {
  readonly entityType: 'ISSUE' | 'COMMENT';
  readonly id:         string;
  readonly projectId:  string;
  readonly title:      string | null;
  readonly excerpt:    string | null;
  readonly score:      number;
}

/**
 * MySQL FULLTEXT search repository.
 * Uses MATCH … AGAINST in NATURAL LANGUAGE MODE for relevance ranking.
 */
export class SearchRepository {
  /**
   * Search issues by title and description.
   * Supports cursor-based pagination via (score, id) composite cursor.
   *
   * @param projectId - Scope to a specific project
   * @param query - Free-text search query
   * @param filters - Optional field filters (type, statusId, assigneeId)
   * @param cursor - Opaque pagination cursor
   * @param limit - Max items per page
   */
  async searchIssues(
    projectId: string,
    query: string,
    filters: { type?: string; statusId?: string; assigneeId?: string },
    cursor?: string,
    limit = 20,
  ): Promise<CursorPage<SearchHit>> {
    let cursorScore: number | null = null;
    let cursorId:    string | null = null;

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const sep = decoded.lastIndexOf('__');
      cursorScore = parseFloat(decoded.slice(0, sep));
      cursorId    = decoded.slice(sep + 2);
    }

    const params: unknown[] = [query, query, projectId];
    let where = 'i.project_id = ? AND i.deleted_at IS NULL';

    if (filters.type)       { where += ' AND i.type = ?';        params.push(filters.type); }
    if (filters.statusId)   { where += ' AND i.status_id = ?';   params.push(filters.statusId); }
    if (filters.assigneeId) { where += ' AND i.assignee_id = ?'; params.push(filters.assigneeId); }

    if (cursorScore !== null && cursorId !== null) {
      where += ' AND (score < ? OR (score = ? AND i.id < ?))';
      params.push(cursorScore, cursorScore, cursorId);
    }

    const rows = await AppDataSource.query(
      `SELECT i.id, i.project_id AS projectId, i.title, i.description AS excerpt,
              MATCH(i.title, i.description) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
       FROM issues i
       WHERE ${where}
       HAVING score > 0
       ORDER BY score DESC, i.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    ) as Array<{ id: string; projectId: string; title: string; excerpt: string | null; score: number }>;

    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, -1) : rows;
    const last    = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor(`${last.score}__${last.id}`)
      : null;

    return {
      items: items.map((r) => ({
        entityType: 'ISSUE' as const,
        id:         r.id,
        projectId:  r.projectId,
        title:      r.title,
        excerpt:    r.excerpt,
        score:      r.score,
      })),
      nextCursor,
      hasMore,
    };
  }

  /**
   * Search comments by content within a project's issues.
   * @param projectId - Project scope
   * @param query - Free-text search query
   * @param cursor - Pagination cursor
   * @param limit - Page size
   */
  async searchComments(
    projectId: string,
    query: string,
    cursor?: string,
    limit = 20,
  ): Promise<CursorPage<SearchHit>> {
    let cursorScore: number | null = null;
    let cursorId:    string | null = null;

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const sep = decoded.lastIndexOf('__');
      cursorScore = parseFloat(decoded.slice(0, sep));
      cursorId    = decoded.slice(sep + 2);
    }

    const params: unknown[] = [query, query, projectId];
    let where = 'i.project_id = ? AND c.deleted_at IS NULL';

    if (cursorScore !== null && cursorId !== null) {
      where += ' AND (score < ? OR (score = ? AND c.id < ?))';
      params.push(cursorScore, cursorScore, cursorId);
    }

    const rows = await AppDataSource.query(
      `SELECT c.id, i.project_id AS projectId, NULL AS title, c.content AS excerpt,
              MATCH(c.content) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
       FROM comments c
       INNER JOIN issues i ON c.issue_id = i.id
       WHERE ${where}
       HAVING score > 0
       ORDER BY score DESC, c.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    ) as Array<{ id: string; projectId: string; title: null; excerpt: string; score: number }>;

    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, -1) : rows;
    const last    = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor(`${last.score}__${last.id}`)
      : null;

    return {
      items: items.map((r) => ({
        entityType: 'COMMENT' as const,
        id:         r.id,
        projectId:  r.projectId,
        title:      null,
        excerpt:    r.excerpt,
        score:      r.score,
      })),
      nextCursor,
      hasMore,
    };
  }
}
