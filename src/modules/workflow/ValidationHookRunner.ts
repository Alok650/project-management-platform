import { IValidationHook, TransitionContext } from './hooks/IValidationHook';
import { UnprocessableError } from '../../core/errors/errors';

/**
 * Chain of Responsibility: runs validation hooks in sequence.
 * The first hook that returns an error message short-circuits the chain.
 */
export class ValidationHookRunner {
  private readonly hooks: ReadonlyArray<IValidationHook>;

  constructor(hooks: IValidationHook[]) {
    this.hooks = hooks;
  }

  /**
   * Execute all hooks in order.
   * @throws {UnprocessableError} On the first hook failure
   */
  async run(ctx: TransitionContext): Promise<void> {
    for (const hook of this.hooks) {
      const error = await hook.validate(ctx);
      if (error) throw new UnprocessableError(error);
    }
  }
}
