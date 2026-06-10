import { ActivityRepository } from './ActivityRepository';
import { eventBus } from '../../core/events/DomainEventBus';
import { ActivityAction } from '../../core/types/enums';
import type { AppDomainEvent } from '../../core/events/events';
import type { ActivityLog } from '../../models/ActivityLog';

/** Subscribes to domain events and writes ActivityLog entries; also exposes the feed API */
export class ActivityService {
  constructor(private readonly repo: ActivityRepository) {
    this.subscribeToEvents();
  }

  /** Register all domain event → activity log mappings */
  private subscribeToEvents(): void {
    eventBus.subscribe<AppDomainEvent>('*', async (event) => {
      const entry = this.toActivityEntry(event);
      if (entry) await this.repo.save(entry);
    });
  }

  /** Map a domain event to an ActivityLog insert payload; returns null for unmapped events */
  private toActivityEntry(event: AppDomainEvent): Partial<ActivityLog> | null {
    switch (event.type) {
      case 'IssueCreated':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.CREATED,
        };
      case 'StatusChanged':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.STATUS_CHANGED,
          oldValue: { statusId: event.payload.fromStatusId },
          newValue: { statusId: event.payload.toStatusId },
        };
      case 'IssueUpdated':
        return {
          projectId: event.payload.projectId, actorId: event.payload.actorId,
          entityType: 'ISSUE', entityId: event.payload.issueId, action: ActivityAction.UPDATED,
          newValue: event.payload.changes,
        };
      case 'CommentAdded':
        return {
          projectId: event.payload.projectId, actorId: event.payload.authorId,
          entityType: 'COMMENT', entityId: event.payload.commentId, action: ActivityAction.COMMENT_ADDED,
        };
      default:
        return null;
    }
  }

  /**
   * Retrieve the paginated activity feed for a project.
   * @param projectId - Project scope
   * @param filters - Optional entity/actor filters
   * @param cursor - Pagination cursor
   * @param limit - Page size
   */
  list(
    projectId: string,
    filters: { entityType?: string; entityId?: string; actorId?: string },
    cursor?: string,
    limit?: number,
  ) {
    return this.repo.listByProject(projectId, filters, cursor, limit);
  }
}
