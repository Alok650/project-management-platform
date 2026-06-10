import { WorkflowAutoAction } from '../../models/WorkflowAutoAction';
import { AppDataSource } from '../../config/database';
import { Issue } from '../../models/Issue';
import { AutoActionType } from '../../core/types/enums';
import { logger } from '../../infrastructure/logger/Logger';

/** Executes automatic actions triggered by a workflow transition */
export class AutoActionExecutor {
  /**
   * Execute all auto-actions for a transition.
   * Actions are best-effort — failures are logged but do not block the transition.
   *
   * @param actions - List of configured auto-actions from the transition
   * @param issue - The issue that was transitioned
   * @param actorId - User who triggered the transition
   */
  async execute(actions: WorkflowAutoAction[], issue: Issue, actorId: string): Promise<void> {
    const repo = AppDataSource.getRepository(Issue);

    for (const action of actions) {
      try {
        if (action.type === AutoActionType.ASSIGN_REVIEWER) {
          const config = action.config as { assignTo: 'current_user' | string };
          const assigneeId = config.assignTo === 'current_user' ? actorId : config.assignTo;
          await repo.update(issue.id, { assigneeId });
        }
        // Additional action types (SET_FIELD, NOTIFY) extend here
      } catch (err) {
        logger.error({ err, actionId: action.id }, 'Auto-action failed');
      }
    }
  }
}
