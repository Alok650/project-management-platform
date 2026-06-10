import { AppDataSource } from '../../config/database';
import { Notification } from '../../models/Notification';
import { NOTIFICATION_CONSTANTS } from './constants';

/** Data access layer for Notification entities */
export class NotificationRepository {
  private readonly repo = AppDataSource.getRepository(Notification);

  /**
   * Persist a new notification.
   * @param data - Partial notification fields to save
   */
  save(data: Partial<Notification>): Promise<Notification> {
    return this.repo.save(data);
  }

  /**
   * Mark all unread notifications as read for a user.
   * @param userId - Target user ID
   */
  markAllRead(userId: string): Promise<void> {
    return this.repo.update({ userId, read: false }, { read: true }).then(() => undefined);
  }

  /**
   * Mark specific notifications as read.
   * @param userId - Target user ID
   * @param ids - Array of notification IDs to mark read
   */
  markRead(userId: string, ids: string[]): Promise<void> {
    return this.repo.update({ userId }, { read: true }).then(() => undefined);
  }

  /**
   * List recent notifications for a user.
   * @param userId - Target user ID
   * @param onlyUnread - When true, return only unread notifications
   */
  listForUser(userId: string, onlyUnread = false): Promise<Notification[]> {
    return this.repo.find({
      where: onlyUnread ? { userId, read: false } : { userId },
      order: { createdAt: 'DESC' },
      take: NOTIFICATION_CONSTANTS.MAX_NOTIFICATIONS_PER_USER,
    });
  }
}
