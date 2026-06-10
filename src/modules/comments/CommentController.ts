import { Context } from 'koa';
import { CommentManager } from './CommentManager';
import { ok } from '../../core/types/ApiResponse';
import { CORE_CONSTANTS } from '../../core/constants';

const manager = new CommentManager();

/** HTTP handler layer for comment endpoints */
export class CommentController {
  /**
   * GET /api/v1/issues/:issueId/comments
   * Returns a cursor-paginated list of top-level comments with replies.
   */
  static async list(ctx: Context): Promise<void> {
    const { cursor, limit } = ctx.query as { cursor?: string; limit?: string };
    ctx.body = ok(await manager.list(
      ctx.params['issueId']!,
      cursor,
      Math.min(Number(limit ?? CORE_CONSTANTS.DEFAULT_PAGE_LIMIT), CORE_CONSTANTS.MAX_PAGE_LIMIT),
    ));
  }

  /**
   * POST /api/v1/issues/:issueId/comments
   * Create a new comment on an issue, optionally as a reply.
   */
  static async create(ctx: Context): Promise<void> {
    const { content, parentId } = ctx.request.body as { content: string; parentId?: string };
    const comment = await manager.create(
      ctx.params['issueId']!,
      ctx.state.user.id,
      content,
      parentId,
      ctx.state.correlationId,
    );
    ctx.status = 201;
    ctx.body = ok(comment);
  }

  /**
   * PATCH /api/v1/comments/:commentId
   * Update comment content. Only the original author may edit.
   */
  static async update(ctx: Context): Promise<void> {
    const { content } = ctx.request.body as { content: string };
    ctx.body = ok(await manager.update(ctx.params['commentId']!, content, ctx.state.user.id));
  }

  /**
   * DELETE /api/v1/comments/:commentId
   * Soft-delete a comment. Only the original author may delete.
   */
  static async delete(ctx: Context): Promise<void> {
    await manager.delete(ctx.params['commentId']!, ctx.state.user.id);
    ctx.status = 204;
  }
}
