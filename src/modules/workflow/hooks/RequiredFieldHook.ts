import { IValidationHook, TransitionContext } from './IValidationHook';
import { StatusCategory, IssueType } from '../../../core/types/enums';

/** Strategy: blocks Done transitions for Story/Epic issues that lack story_points */
export class RequiredFieldHook implements IValidationHook {
  async validate(ctx: TransitionContext): Promise<string | null> {
    const { issue, transition } = ctx;
    if (
      transition.toStatus?.category === StatusCategory.DONE &&
      (issue.type === IssueType.STORY || issue.type === IssueType.EPIC) &&
      issue.storyPoints == null
    ) {
      return 'Story points are required before moving to Done';
    }
    return null;
  }
}
