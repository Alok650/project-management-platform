import { DomainEvent } from './DomainEvent';

export interface IssueCreatedEvent extends DomainEvent {
  readonly type: 'IssueCreated';
  readonly payload: { issueId: string; projectId: string; actorId: string };
}
export interface StatusChangedEvent extends DomainEvent {
  readonly type: 'StatusChanged';
  readonly payload: {
    issueId: string; projectId: string;
    fromStatusId: string; toStatusId: string; actorId: string;
  };
}
export interface IssueUpdatedEvent extends DomainEvent {
  readonly type: 'IssueUpdated';
  readonly payload: { issueId: string; projectId: string; changes: Record<string, unknown>; actorId: string };
}
export interface IssueMovedEvent extends DomainEvent {
  readonly type: 'IssueMoved';
  readonly payload: {
    issueId: string; projectId: string;
    fromSprintId: string | null; toSprintId: string | null; actorId: string;
  };
}
export interface CommentAddedEvent extends DomainEvent {
  readonly type: 'CommentAdded';
  readonly payload: { commentId: string; issueId: string; projectId: string; authorId: string; mentions: string[] };
}
export interface SprintUpdatedEvent extends DomainEvent {
  readonly type: 'SprintUpdated';
  readonly payload: { sprintId: string; projectId: string; actorId: string };
}

export type AppDomainEvent =
  | IssueCreatedEvent | StatusChangedEvent | IssueUpdatedEvent
  | IssueMovedEvent | CommentAddedEvent | SprintUpdatedEvent;
