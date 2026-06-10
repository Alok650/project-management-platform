import { IValidationHook, TransitionContext } from './IValidationHook';
import { AppDataSource } from '../../../config/database';
import { Issue } from '../../../models/Issue';

/** Strategy: blocks a transition if the target status has reached its WIP limit */
export class WipLimitHook implements IValidationHook {
  async validate(ctx: TransitionContext): Promise<string | null> {
    const toStatus = ctx.transition.toStatus;
    if (!toStatus?.wipLimit) return null;

    const currentCount = await AppDataSource.getRepository(Issue).count({
      where: { projectId: ctx.issue.projectId, statusId: toStatus.id },
    });

    if (currentCount >= toStatus.wipLimit) {
      return `WIP limit of ${toStatus.wipLimit} reached for status '${toStatus.name}'`;
    }
    return null;
  }
}
