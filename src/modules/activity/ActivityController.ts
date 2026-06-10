import { Context } from 'koa';
import { ActivityService } from './ActivityService';
import { ActivityRepository } from './ActivityRepository';
import { ok } from '../../core/types/ApiResponse';
import { CORE_CONSTANTS } from '../../core/constants';

const service = new ActivityService(new ActivityRepository());

/** HTTP handler layer for the activity feed endpoint */
export class ActivityController {
  /** GET /api/v1/projects/:projectId/activity */
  static async list(ctx: Context): Promise<void> {
    const { cursor, limit, entityType, entityId, actorId } = ctx.query as Record<string, string | undefined>;
    const page = await service.list(
      ctx.params['projectId']!,
      { entityType, entityId, actorId },
      cursor,
      Math.min(Number(limit ?? CORE_CONSTANTS.DEFAULT_PAGE_LIMIT), CORE_CONSTANTS.MAX_PAGE_LIMIT),
    );
    ctx.body = ok(page);
  }
}
