import { IssueType, IssuePriority } from '../../core/types/enums';

/** DTO for creating a new issue */
export interface CreateIssueDto {
  readonly type: IssueType;
  readonly title: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly assigneeId?: string;
  readonly parentId?: string;
  readonly sprintId?: string;
  readonly storyPoints?: number;
  readonly labels?: readonly string[];
  readonly statusId?: string;
}

/** DTO for updating an issue — version is required for optimistic locking */
export interface UpdateIssueDto {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: IssuePriority;
  readonly assigneeId?: string | null;
  readonly sprintId?: string | null;
  readonly storyPoints?: number | null;
  readonly labels?: readonly string[];
  readonly version: number;
}
