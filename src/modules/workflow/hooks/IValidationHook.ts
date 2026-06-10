import type { Issue } from '../../../models/Issue';
import type { WorkflowTransition } from '../../../models/WorkflowTransition';

/** Context passed to every validation hook during a status transition */
export interface TransitionContext {
  readonly issue: Issue;
  readonly transition: WorkflowTransition;
  readonly actorId: string;
  readonly correlationId: string;
}

/** Strategy interface for workflow transition validation */
export interface IValidationHook {
  /** @returns null if the transition is valid, or an error message string if blocked */
  validate(ctx: TransitionContext): Promise<string | null>;
}
