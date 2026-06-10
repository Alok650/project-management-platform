import { Context } from 'koa';
import { IssueManager } from './IssueManager';
import { ok } from '../../core/types/ApiResponse';
import { CORE_CONSTANTS } from '../../core/constants';

const manager = new IssueManager();

/** HTTP handler layer for issue endpoints */
export class IssueController {
  /** POST /api/v1/projects/:projectId/issues */
  static async create(ctx: Context): Promise<void> {
    const issue = await manager.create(
      ctx.params['projectId']!,
      ctx.request.body as any,
      ctx.state.user.id,
      ctx.state.correlationId,
    );
    ctx.status = 201;
    ctx.body = ok(issue);
  }

  /** GET /api/v1/projects/:projectId/board */
  static async getBoard(ctx: Context): Promise<void> {
    const sprintId = (ctx.query['sprintId'] as string | undefined) ?? null;
    ctx.body = ok(await manager.getBoard(ctx.params['projectId']!, sprintId));
  }

  /** GET /api/v1/projects/:projectId/issues */
  static async list(ctx: Context): Promise<void> {
    const { cursor, limit, ...filters } = ctx.query as Record<string, string | undefined>;
    const page = await manager.list(
      ctx.params['projectId']!,
      filters as any,
      { cursor, limit: Math.min(Number(limit ?? CORE_CONSTANTS.DEFAULT_PAGE_LIMIT), CORE_CONSTANTS.MAX_PAGE_LIMIT) },
    );
    ctx.body = ok(page);
  }

  /** GET /api/v1/issues/:issueId */
  static async get(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.getById(ctx.params['issueId']!));
  }

  /** PATCH /api/v1/issues/:issueId */
  static async update(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.update(
      ctx.params['issueId']!,
      ctx.request.body as any,
      ctx.state.user.id,
      ctx.state.correlationId,
    ));
  }

  /** POST /api/v1/issues/:issueId/transitions */
  static async transition(ctx: Context): Promise<void> {
    const { toStatusId } = ctx.request.body as { toStatusId: string };
    ctx.body = ok(await manager.transition(
      ctx.params['issueId']!,
      toStatusId,
      ctx.state.user.id,
      ctx.state.correlationId,
    ));
  }

  /** DELETE /api/v1/issues/:issueId */
  static async delete(ctx: Context): Promise<void> {
    await manager.delete(ctx.params['issueId']!);
    ctx.status = 204;
  }

  /** POST /api/v1/issues/:issueId/watchers */
  static async watch(ctx: Context): Promise<void> {
    await manager.addWatcher(ctx.params['issueId']!, ctx.state.user.id);
    ctx.status = 204;
  }

  /** DELETE /api/v1/issues/:issueId/watchers */
  static async unwatch(ctx: Context): Promise<void> {
    await manager.removeWatcher(ctx.params['issueId']!, ctx.state.user.id);
    ctx.status = 204;
  }
}
