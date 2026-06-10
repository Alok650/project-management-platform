import { CircuitBreaker } from './CircuitBreaker';
import { NotificationRepository } from './NotificationRepository';
import { enqueueNotification } from './SqsProducer';
import { eventBus } from '../../core/events/DomainEventBus';
import { NotifType } from '../../core/types/enums';
import { logger } from '../../infrastructure/logger/Logger';
import type { CommentAddedEvent, IssueCreatedEvent } from '../../core/events/events';
import type { Notification } from '../../models/Notification';
import { randomUUID } from 'crypto';

/**
 * Handles notification delivery with circuit-breaker protection.
 * When the CB opens, notifications are queued to SQS for later delivery.
 * Subscribes to domain events at construction time.
 */
export class NotificationService {
  private readonly cb   = new CircuitBreaker('notification-service');
  private readonly repo = new NotificationRepository();

  constructor() {
    this.subscribeToEvents();
  }

  /** Register domain event → notification handlers */
  private subscribeToEvents(): void {
    eventBus.subscribe<CommentAddedEvent>('CommentAdded', async (event) => {
      for (const mentionedUserId of event.payload.mentions) {
        await this.deliver({
          userId:     mentionedUserId,
          type:       NotifType.MENTIONED,
          entityType: 'COMMENT',
          entityId:   event.payload.commentId,
          message:    'You were mentioned in a comment',
        });
      }
    });

    eventBus.subscribe<IssueCreatedEvent>('IssueCreated', async (event) => {
      // Notify assignee if set — assigneeId would need to be in the payload;
      // for now this is a hook point for future enrichment
      logger.debug({ event: event.type }, 'IssueCreated notification hook (no assignee in payload)');
    });
  }

  /**
   * Deliver a notification via circuit-breaker-protected path.
   * Falls back to SQS queue when CB is open.
   *
   * @param data - Notification data to deliver
   */
  async deliver(data: {
    userId:     string;
    type:       NotifType;
    entityType: string;
    entityId:   string;
    message:    string;
  }): Promise<void> {
    const notificationId = randomUUID();

    try {
      await this.cb.execute(async () => {
        const saved = await this.repo.save({ ...data, read: false });
        logger.debug({ notificationId: saved.id, userId: data.userId }, 'Notification delivered');
      });
    } catch (err) {
      // Circuit is open — queue for later delivery
      logger.warn({ err, userId: data.userId }, 'Circuit open — queuing notification');
      await enqueueNotification({
        notificationId,
        userId:     data.userId,
        type:       data.type,
        entityType: data.entityType,
        entityId:   data.entityId,
        message:    data.message,
      }).catch((sqsErr) => {
        logger.error({ sqsErr }, 'Failed to enqueue notification to SQS');
      });
    }
  }

  /**
   * List notifications for the authenticated user.
   * @param userId - Target user ID
   * @param onlyUnread - When true, return only unread notifications
   */
  listForUser(userId: string, onlyUnread?: boolean): Promise<Notification[]> {
    return this.repo.listForUser(userId, onlyUnread);
  }

  /**
   * Mark all notifications as read for a user.
   * @param userId - Target user ID
   */
  markAllRead(userId: string): Promise<void> {
    return this.repo.markAllRead(userId);
  }
}
