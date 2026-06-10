import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env } from '../../config/env';
import { logger } from '../../infrastructure/logger/Logger';

/** Job payload sent to SQS when the circuit breaker is open or for async delivery */
export interface NotificationJob {
  readonly notificationId: string;
  readonly userId: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly message: string;
}

const sqsClient = new SQSClient({
  region: env.AWS_REGION,
  ...(env.AWS_ENDPOINT ? { endpoint: env.AWS_ENDPOINT } : {}),
  credentials: {
    accessKeyId:     env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Push a notification job onto the ElasticMQ/SQS delivery queue.
 * @param job - Notification payload to queue
 */
export const enqueueNotification = async (job: NotificationJob): Promise<void> => {
  await sqsClient.send(new SendMessageCommand({
    QueueUrl:    env.SQS_NOTIFICATION_QUEUE_URL,
    MessageBody: JSON.stringify(job),
  }));
  logger.debug({ notificationId: job.notificationId, userId: job.userId }, 'Notification enqueued');
};
