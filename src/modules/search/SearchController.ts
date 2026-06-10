import { Context } from 'koa';
import { SearchRepository } from './SearchRepository';
import { ok } from '../../core/types/ApiResponse';
import { SEARCH_CONSTANTS } from './constants';

const repo = new SearchRepository();

/** HTTP handler layer for unified search */
export class SearchController {
  /**
   * GET /api/v1/projects/:projectId/search
   * Query params: q (required), type (ISSUE|COMMENT), cursor, limit, statusId, assigneeId, issueType
   */
  static async search(ctx: Context): Promise<void> {
    const { q, type, cursor, limit, statusId, assigneeId, issueType } = ctx.query as Record<string, string | undefined>;

    if (!q || q.length < SEARCH_CONSTANTS.MIN_QUERY_LENGTH) {
      ctx.status = 400;
      ctx.body   = { error: `Query must be at least ${SEARCH_CONSTANTS.MIN_QUERY_LENGTH} characters` };
      return;
    }

    const pageLimit = Math.min(Number(limit ?? SEARCH_CONSTANTS.DEFAULT_LIMIT), SEARCH_CONSTANTS.MAX_LIMIT);
    const projectId = ctx.params['projectId']!;

    if (type === 'COMMENT') {
      ctx.body = ok(await repo.searchComments(projectId, q, cursor, pageLimit));
    } else {
      ctx.body = ok(await repo.searchIssues(projectId, q, { type: issueType, statusId, assigneeId }, cursor, pageLimit));
    }
  }
}
