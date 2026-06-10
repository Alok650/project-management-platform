import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import pLimit from 'p-limit';
import { env } from '../../config/env';
import { logger } from '../../infrastructure/logger/Logger';
import { NotificationRepository } from './NotificationRepository';
import { CircuitBreaker } from './CircuitBreaker';
import type { NotificationJob } from './SqsProducer';
import { NotifType } from '../../core/types/enums';
import { CORE_CONSTANTS } from '../../core/constants';

const sqsClient = new SQSClient({
  region: env.AWS_REGION,
  ...(env.AWS_ENDPOINT ? { endpoint: env.AWS_ENDPOINT } : {}),
  credentials: {
    accessKeyId:     env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Long-poll SQS consumer that delivers queued notifications when the circuit is closed.
 * Runs continuously until stopped.
 */
export class SqsConsumer {
  private running = false;
  private readonly repo = new NotificationRepository();
  private readonly cb   = new CircuitBreaker('notification-service');

  /** Start the long-poll consumer loop */
  start(): void {
    this.running = true;
    void this.poll();
  }

  /** Stop the consumer loop */
  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await sqsClient.send(new ReceiveMessageCommand({
          QueueUrl:            env.SQS_NOTIFICATION_QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds:     20,
        }));

        const limit = pLimit(CORE_CONSTANTS.CONCURRENCY_LIMIT);
        await Promise.all(
          (result.Messages ?? []).map((msg) =>
            limit(async () => {
              try {
                const job: NotificationJob = JSON.parse(msg.Body ?? '{}');
                const cbState = await this.cb.getState();

                if (cbState !== 'OPEN') {
                  await this.repo.save({
                    userId:     job.userId,
                    type:       job.type as NotifType,
                    entityType: job.entityType,
                    entityId:   job.entityId,
                    message:    job.message,
                    read:       false,
                  });

                  await sqsClient.send(new DeleteMessageCommand({
                    QueueUrl:      env.SQS_NOTIFICATION_QUEUE_URL,
                    ReceiptHandle: msg.ReceiptHandle!,
                  }));

                  logger.debug({ notificationId: job.notificationId }, 'Queued notification delivered');
                }
              } catch (err) {
                logger.error({ err, messageId: msg.MessageId }, 'Failed to process SQS message');
              }
            }),
          ),
        );
      } catch (err) {
        logger.error({ err }, 'SQS poll error');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }
}
