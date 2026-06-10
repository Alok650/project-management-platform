import { Context } from 'koa';
import { SprintManager } from './SprintManager';
import { ok } from '../../core/types/ApiResponse';

const manager = new SprintManager();

/** HTTP handler layer for sprint endpoints */
export class SprintController {
  /** GET /api/v1/projects/:projectId/sprints */
  static async list(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.list(ctx.params['projectId']!));
  }

  /** POST /api/v1/projects/:projectId/sprints */
  static async create(ctx: Context): Promise<void> {
    const sprint = await manager.create(ctx.params['projectId']!, ctx.request.body as any);
    ctx.status = 201;
    ctx.body = ok(sprint);
  }

  /** POST /api/v1/sprints/:sprintId/start */
  static async start(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.start(ctx.params['sprintId']!, ctx.state.user.id, ctx.state.correlationId));
  }

  /** POST /api/v1/sprints/:sprintId/complete */
  static async complete(ctx: Context): Promise<void> {
    const { carryOverIssueIds, nextSprintId } = ctx.request.body as { carryOverIssueIds: string[]; nextSprintId?: string };
    ctx.body = ok(await manager.complete(ctx.params['sprintId']!, carryOverIssueIds, nextSprintId, ctx.state.user.id, ctx.state.correlationId));
  }
}
