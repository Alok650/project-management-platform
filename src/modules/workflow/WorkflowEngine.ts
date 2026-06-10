import { AppDataSource } from '../../config/database';
import { Issue } from '../../models/Issue';
import { WorkflowRepository } from './WorkflowRepository';
import { ValidationHookRunner } from './ValidationHookRunner';
import { AutoActionExecutor } from './AutoActionExecutor';
import { WipLimitHook } from './hooks/WipLimitHook';
import { RequiredFieldHook } from './hooks/RequiredFieldHook';
import { eventBus } from '../../core/events/DomainEventBus';
import { UnprocessableError } from '../../core/errors/errors';
import type { StatusChangedEvent } from '../../core/events/events';

/**
 * Orchestrates workflow status transitions.
 * Flow: validate allowed → run hooks (CoR) → persist → run auto-actions → emit event.
 */
export class WorkflowEngine {
  private readonly workflowRepo   = new WorkflowRepository();
  private readonly hookRunner     = new ValidationHookRunner([new WipLimitHook(), new RequiredFieldHook()]);
  private readonly actionExecutor = new AutoActionExecutor();

  /**
   * Execute a status transition for an issue.
   *
   * @param issue - The issue being transitioned (must include current statusId)
   * @param toStatusId - Target workflow status UUID
   * @param actorId - User performing the transition
   * @param correlationId - Request correlation ID for tracing
   * @returns Updated issue with new statusId
   * @throws {UnprocessableError} If transition is not configured or a hook blocks it
   */
  async transition(issue: Issue, toStatusId: string, actorId: string, correlationId: string): Promise<Issue> {
    const transition = await this.workflowRepo.findTransition(issue.statusId, toStatusId);
    if (!transition) {
      const allowed = await this.workflowRepo.findAllowedTransitions(issue.statusId);
      throw new UnprocessableError(
        `Transition from current status to '${toStatusId}' is not allowed`,
        allowed.map((t) => t.toStatusId),
      );
    }

    await this.hookRunner.run({ issue, transition, actorId, correlationId });

    const fromStatusId = issue.statusId;
    const updated = await AppDataSource.transaction(async (em) => {
      await em.update(Issue, { id: issue.id }, { statusId: toStatusId });
      return em.findOneOrFail(Issue, { where: { id: issue.id } });
    });

    if (transition.autoActions?.length) {
      await this.actionExecutor.execute(transition.autoActions, updated, actorId);
    }

    const event: StatusChangedEvent = {
      type: 'StatusChanged',
      occurredAt: new Date(),
      correlationId,
      payload: { issueId: issue.id, projectId: issue.projectId, fromStatusId, toStatusId, actorId },
    };
    eventBus.publish(event);

    return updated;
  }
}
