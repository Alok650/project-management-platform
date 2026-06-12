# Async Notifications — SQS & Circuit Breaker

## What You'll Learn

- Why message queues exist and what problems they solve compared to direct HTTP calls
- Amazon SQS delivery semantics: at-least-once delivery, visibility timeout, and dead-letter queues
- The producer/consumer pattern and how to implement it safely
- The Circuit Breaker pattern from first principles: what the three states mean, how transitions are triggered, and why shared state across pods is mandatory
- What back-pressure is and how circuit breaking provides it
- What ElasticMQ is and why it is the correct tool to simulate SQS locally
- A complete walkthrough of the notifications module: `NotificationService`, `SqsProducer`, `SqsConsumer`, `CircuitBreaker`, `NotificationRepository`, and `elasticmq.conf`
- A step-by-step end-to-end trace: from a user being @mentioned in a comment to the notification appearing in their inbox

---

## Part 1 — Theory

### 1.1 What Is a Message Queue, and Why Does It Exist?

Consider a naive approach: when a user posts a comment and mentions three people, the HTTP request handler synchronously calls `sendEmail()` for each mentioned user before returning a response. That design has three compounding problems:

1. **Latency coupling.** The caller waits for all three email sends. If your email provider takes 300 ms per send, the comment POST takes at least 900 ms. The user feels that commenting is slow even though email has nothing to do with saving a comment.
2. **Availability coupling.** If the email provider is down, the comment POST fails entirely. A transient third-party outage now destroys your write path.
3. **Retry logic proliferation.** Every service that wants to send notifications has to independently implement retry logic, backoff, deduplication, and error handling.

A message queue decouples the producer (the code that has something to announce) from the consumer (the code that acts on it) in both time and availability. The producer writes a lightweight message to a durable buffer and returns immediately. The consumer reads from that buffer at its own pace, retries failed messages automatically, and can be scaled independently.

```
Without a queue                          With a queue
─────────────────────────────────────    ────────────────────────────────────
POST /comments                           POST /comments
  │                                        │
  ├─ save comment        (sync)            ├─ save comment        (sync)
  ├─ send email user A   (sync, slow)      ├─ publish message     (sync, fast)
  ├─ send email user B   (sync, slow)      └─ return 201 Created
  ├─ send email user C   (sync, slow)
  └─ return 201 Created                  [later, in consumer process]
                                           ├─ send email user A
                                           ├─ send email user B
                                           └─ send email user C
```

The queue acts as a shock absorber: if email sending slows down, messages pile up in the queue rather than blocking API requests. The queue itself is durable — messages survive a consumer crash and are retried.

### 1.2 Amazon SQS: Key Concepts

**Amazon Simple Queue Service (SQS)** is a managed message queue offered by AWS. You do not run or maintain any queue infrastructure; you interact with it through HTTP API calls.

#### At-Least-Once Delivery

SQS guarantees that every message will be delivered to a consumer at least once. It does not guarantee exactly-once delivery. This means your consumer must be **idempotent**: processing the same message twice should produce the same result as processing it once. In the notifications module this is handled by checking the circuit breaker state before acting and by relying on the database's unique constraint on the notification ID.

#### Visibility Timeout

When a consumer receives a message, SQS does not immediately delete it. Instead, SQS makes the message **invisible** to other consumers for a configurable window called the **visibility timeout**. If the consumer successfully processes the message and deletes it before the timeout expires, the message is gone. If the consumer crashes or fails to delete the message within the timeout window, SQS makes the message visible again and another consumer instance picks it up.

```
Consumer receives message
│
│← visibility timeout (e.g. 10 s) begins →│
│                                           │
├─ process message                          │
├─ delete message          ← success        │
   (message gone permanently)               │
                                           OR
                         consumer crashes  │
                         message reappears │
                         another consumer  │
                         picks it up       │
```

The visibility timeout is the mechanism that enables retries without explicit retry code on the producer side.

#### Dead-Letter Queue (DLQ)

If a message fails processing repeatedly (reaches a configurable `maxReceiveCount`), SQS automatically moves it to a designated **dead-letter queue**. The DLQ holds "poison pill" messages — messages that cannot be processed — without blocking the main queue. Operations engineers can inspect the DLQ, fix the root cause, and replay messages into the main queue.

In this codebase, `elasticmq.conf` configures the DLQ with a `maxReceiveCount` of 3, meaning a message that fails three consecutive times is moved to `notification-delivery-dlq` automatically.

### 1.3 The Producer/Consumer Pattern

The producer/consumer pattern separates the concern of creating work from the concern of executing it. The pattern has three components:

- **Producer**: Generates tasks and writes them to a shared buffer (the queue). The producer does not know or care who will execute the work.
- **Queue**: A durable, ordered (or unordered) buffer that decouples producers and consumers in time and space.
- **Consumer**: Reads tasks from the queue and executes them. The consumer does not know or care who produced the work.

```pseudocode
// Producer
function handleCommentCreated(comment):
    saveCommentToDatabase(comment)
    queue.push({ type: "notify_mention", mentionedUser: comment.mentions, commentId: comment.id })
    return success

// Consumer (runs continuously in background)
while true:
    messages = queue.receive(maxMessages=10, waitSeconds=20)
    for message in messages:
        processNotification(message)
        queue.delete(message)
```

### 1.4 The Circuit Breaker Pattern

#### The Electrical Analogy

The name comes from electrical engineering. A household circuit breaker is a switch that monitors current flow. Under normal conditions it stays closed (current flows freely). If a short circuit causes dangerously high current, the breaker **opens** (breaks the circuit), stopping current flow and protecting downstream components. A technician can then manually test the circuit in a controlled way and reset the breaker if it is safe.

The software circuit breaker applies the same logic to service calls: if a downstream dependency (a database, a queue, an external API) starts failing, the circuit breaker stops sending requests to it immediately rather than hammering a broken service with retries and building up latency.

#### Three States

```
                   failure count >= threshold
        ┌─────────────────────────────────────────┐
        │                                         ▼
   ┌────┴────┐                              ┌──────────┐
   │ CLOSED  │                              │   OPEN   │
   │(normal) │                              │ (reject  │
   └────┬────┘                              │  fast)   │
        ▲                                   └────┬─────┘
        │                                        │
        │  probe succeeds                        │  timeout expires
        │                                        ▼
        │                                 ┌────────────┐
        └─────────────────────────────────┤ HALF_OPEN  │
                                          │  (probe)   │
                                          └────────────┘
                                                │
                                                │ probe fails
                                                ▼
                                          ┌──────────┐
                                          │   OPEN   │
                                          │(re-open) │
                                          └──────────┘
```

**CLOSED** — Normal operating state. All calls pass through. Failures are counted. When the failure count reaches the threshold, transition to OPEN.

**OPEN** — The breaker has tripped. All calls are rejected immediately without attempting to contact the dependency. This is "failing fast": the caller gets an error instantly and can fall back to an alternative path (like queuing the work for later). After a configured timeout, the state transitions to HALF_OPEN.

**HALF_OPEN** — A probe state. The breaker allows exactly one call through to test whether the dependency has recovered. If that call succeeds, transition to CLOSED and resume normal operation. If it fails, transition back to OPEN and restart the timeout.

Here is a pseudocode implementation of the pattern before looking at the actual codebase:

```typescript
// Generic circuit breaker — pseudocode
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount = 0;
  private openedAt: number | null = null;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt! > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit is OPEN — fast fail');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED';   // probe succeeded
        this.failureCount = 0;
      }
      return result;
    } catch (err) {
      this.failureCount++;
      if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
        this.openedAt = Date.now();
      }
      throw err;
    }
  }
}
```

#### Why Shared State Across Pods Is Critical

The pseudocode above stores state in memory (`this.state`). This works when you have exactly one process. In a production deployment, you run multiple pods behind a load balancer. If each pod holds its own in-memory state, the following happens:

- Pod A has seen 5 failures and opens its circuit.
- Pod B has seen 0 failures and continues sending requests to the broken dependency.
- The dependency continues to receive load from Pod B even though the system "decided" to open the circuit.
- When Pod A restarts, it resets to CLOSED and starts sending requests again immediately, losing all failure history.

**The circuit breaker state must be shared across all pods.** Redis is the natural solution: it is a fast, shared, in-process store that all pods can read and write atomically. The circuit state becomes a single value in Redis rather than a per-pod variable.

The actual `CircuitBreaker` in this codebase stores its OPEN state as a Redis key with a TTL (the timeout in seconds). When the key expires, Redis removes it, which is equivalent to the automatic transition to HALF_OPEN. If no key exists, `getState()` returns `'CLOSED'` as the default — no Redis key means the circuit is healthy.

### 1.5 Back-Pressure and Circuit Breaking

**Back-pressure** is the mechanism by which a downstream system signals to upstream producers that it cannot handle more load. Without back-pressure, a slow consumer causes queues to grow unboundedly, eventually exhausting memory or causing cascading failures.

A circuit breaker provides a form of back-pressure: once the circuit opens, the producer stops sending work to the broken dependency and either queues the work (offloading to SQS) or drops it. This prevents the failing dependency from receiving an overwhelming retry storm while it recovers.

### 1.6 ElasticMQ: Local SQS Emulation

ElasticMQ is an in-memory message queue server written in Scala that exposes an SQS-compatible HTTP API. The AWS SDK client cannot distinguish between a real SQS endpoint and an ElasticMQ endpoint; they speak the same protocol.

Why not use real SQS in local development?

- Requires valid AWS credentials on every developer's machine.
- Introduces network latency and cost.
- Tests that create and delete queues can interfere with team-shared queues.
- Local tests need deterministic, repeatable behavior that is hard to guarantee with a live external service.

ElasticMQ runs as a Docker container alongside the application, configured entirely through `elasticmq.conf`. It starts fresh every time Docker Compose is run, giving each developer a clean slate.

---

## Part 2 — Implementation Walkthrough

### 2.1 Configuration: `elasticmq.conf`

```hocon
// elasticmq.conf
include classpath("application.conf")
queues {
  notification-delivery-dlq {
    defaultVisibilityTimeout = 30 seconds
    delay = 0 seconds
    receiveMessageWait = 0 seconds
  }
  notification-delivery {
    defaultVisibilityTimeout = 10 seconds
    delay = 0 seconds
    receiveMessageWait = 0 seconds
    deadLetterQueue {
      name = notification-delivery-dlq
      maxReceiveCount = 3
    }
  }
}
node-address {
  protocol = http
  host = "*"
  port = 9324
}
rest-sqs {
  enabled = true
  bind-port = 9324
  bind-hostname = "0.0.0.0"
  sqs-limits = strict
}
```

This file is read by ElasticMQ on startup. Breaking it down:

- **`notification-delivery`** is the main work queue. The `defaultVisibilityTimeout = 10 seconds` means a consumer has 10 seconds to process a message and delete it before SQS makes it visible to other consumers again. This is the heartbeat of the retry mechanism.
- **`notification-delivery-dlq`** is the dead-letter queue. The `maxReceiveCount = 3` in the parent queue's `deadLetterQueue` block means: if a message is received (and not deleted) 3 times, move it to the DLQ automatically. The DLQ's longer visibility timeout (30 seconds) reflects the expectation that DLQ processing is manual or slower.
- **`node-address` and `rest-sqs`** configure the HTTP server. Port 9324 is the ElasticMQ default and matches what the application reads from the `AWS_ENDPOINT` environment variable.
- **`sqs-limits = strict`** tells ElasticMQ to enforce SQS API constraints (e.g., message size limits, valid attribute names), which catches bugs that would also fail in production.

### 2.2 Constants: `notifications/constants.ts`

```typescript
// src/modules/notifications/constants.ts
export const NOTIFICATION_CONSTANTS = {
  CIRCUIT_BREAKER_THRESHOLD: 5,
  CIRCUIT_BREAKER_TIMEOUT_SECONDS: 30,
  MAX_NOTIFICATIONS_PER_USER: 50,
} as const;
```

Three configuration values drive the behaviour of the entire module:

- **`CIRCUIT_BREAKER_THRESHOLD: 5`** — the circuit opens after 5 consecutive failures. Choosing this value involves a trade-off: too low and transient errors (a single slow database query) trip the circuit unnecessarily; too high and the circuit takes too long to protect the system from a real outage.
- **`CIRCUIT_BREAKER_TIMEOUT_SECONDS: 30`** — the circuit stays OPEN for 30 seconds before transitioning to HALF_OPEN for a probe. 30 seconds gives the downstream dependency (the database) time to recover from a transient failure.
- **`MAX_NOTIFICATIONS_PER_USER: 50`** — the repository caps reads at 50 notifications. This prevents `listForUser` from returning an unbounded result set.

### 2.3 The Data Model: `Notification.ts`

```typescript
// src/models/Notification.ts
@Entity('notifications')
@Index('idx_notifications_user_read_created', ['userId', 'read', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'enum', enum: NotifType })
  type!: NotifType;

  @Column({ name: 'entity_type', length: 50 })
  entityType!: string;

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'boolean', default: false })
  read!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;
}
```

The `@Index` decorator on `['userId', 'read', 'createdAt']` is intentional: the two most common queries are "give me all unread notifications for user X" and "give me the 50 most recent notifications for user X, ordered by date". The composite index covers both patterns because `userId` is the leading column (highest selectivity filter) followed by `read` (a boolean filter to narrow the set) and `createdAt` (used for `ORDER BY DESC`).

The `entityType` and `entityId` fields form a polymorphic reference: a notification can point to a comment (`entityType='COMMENT'`, `entityId='<uuid>'`) or an issue without requiring separate foreign-key columns for each entity type.

### 2.4 `NotificationRepository.ts`

```typescript
// src/modules/notifications/NotificationRepository.ts
export class NotificationRepository {
  private readonly repo = AppDataSource.getRepository(Notification);

  save(data: Partial<Notification>): Promise<Notification> {
    return this.repo.save(data);
  }

  markAllRead(userId: string): Promise<void> {
    return this.repo.update({ userId, read: false }, { read: true }).then(() => undefined);
  }

  listForUser(userId: string, onlyUnread = false): Promise<Notification[]> {
    return this.repo.find({
      where: onlyUnread ? { userId, read: false } : { userId },
      order: { createdAt: 'DESC' },
      take: NOTIFICATION_CONSTANTS.MAX_NOTIFICATIONS_PER_USER,
    });
  }
}
```

The repository persists every successfully delivered notification to the database. This serves as an **audit trail**: even if the in-app notification bell is later redesigned or cleared, the `notifications` table is a permanent record of every notification event that reached the user. The `read` column enables the "unread count" badge in the UI without a separate counter variable that could drift out of sync.

The `markAllRead` method uses TypeORM's `update` (a single SQL `UPDATE ... WHERE user_id = $1 AND read = false SET read = true`) rather than loading all records and saving them individually. This avoids an N+1 write pattern.

### 2.5 `CircuitBreaker.ts` — Deep Dive

```typescript
// src/modules/notifications/CircuitBreaker.ts
type CbState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private readonly name: string;
  private readonly threshold: number;
  private readonly timeout: number;
  private failureCount = 0;

  constructor(
    name: string,
    threshold: number = NOTIFICATION_CONSTANTS.CIRCUIT_BREAKER_THRESHOLD,
    timeoutSeconds: number = NOTIFICATION_CONSTANTS.CIRCUIT_BREAKER_TIMEOUT_SECONDS,
  ) {
    this.name      = name;
    this.threshold = threshold;
    this.timeout   = timeoutSeconds;
  }

  async getState(): Promise<CbState> {
    const raw = await redis.get(CacheKeys.circuitBreaker(this.name));
    return (raw as CbState | null) ?? 'CLOSED';
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.getState();
    if (state === 'OPEN') throw new Error(`Circuit breaker '${this.name}' is OPEN`);

    try {
      const result = await fn();
      if (state === 'HALF_OPEN') {
        await redis.del(CacheKeys.circuitBreaker(this.name));
        this.failureCount = 0;
        logger.info({ circuitBreaker: this.name }, 'Circuit breaker CLOSED');
      }
      return result;
    } catch (err) {
      this.failureCount++;
      if (this.failureCount >= this.threshold) {
        await redis.setex(CacheKeys.circuitBreaker(this.name), this.timeout, 'OPEN');
        logger.warn({ circuitBreaker: this.name, threshold: this.threshold }, 'Circuit breaker OPEN');
      }
      throw err;
    }
  }
}
```

The Redis key format, from `CacheKeys.circuitBreaker`:

```typescript
// src/infrastructure/cache/CacheKeys.ts
circuitBreaker: (name: string) => `cb:${name}`,
```

So for the `'notification-service'` circuit breaker, the Redis key is `cb:notification-service`.

**How the HALF_OPEN state works in this implementation:**

The HALF_OPEN state is not stored explicitly. Instead, it is derived from the absence of the Redis key combined with the TTL expiry. When the circuit opens, Redis stores the key `cb:notification-service` with value `'OPEN'` and a TTL of 30 seconds. After 30 seconds, Redis expires and deletes the key automatically. The next call to `getState()` finds no key and returns `'CLOSED'` (the default). However, `execute()` checks the state *before* calling the function:

- If it reads `'CLOSED'` and the function succeeds, everything is fine.
- If it reads `'CLOSED'` (because the key just expired) and the function fails, the failure counter increments and the circuit can re-open.

This is a simplified implementation where the HALF_OPEN probe logic is implicit: the first request after the timeout acts as the probe. A full production implementation would store `'HALF_OPEN'` as a separate Redis value and only allow one concurrent probe (using a Redis `SETNX` or Lua script to prevent two simultaneous requests from both acting as probes during HALF_OPEN).

**The `failureCount` field is per-instance, not per-cluster.** This is an important nuance: `failureCount` is an in-memory counter on a single pod. The circuit opens when a single pod accumulates 5 failures. If you have 3 pods and they each see 4 failures, none of them will open the circuit even though the system has collectively seen 12 failures. For the notification use case this is an acceptable trade-off — the worst case is that the circuit opens 30 seconds later than ideal. A stricter implementation would use a Redis `INCR` with a TTL for the failure counter as well.

### 2.6 `SqsProducer.ts`

```typescript
// src/modules/notifications/SqsProducer.ts
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

export const enqueueNotification = async (job: NotificationJob): Promise<void> => {
  if (!env.SQS_NOTIFICATION_QUEUE_URL) {
    logger.warn({ notificationId: job.notificationId }, 'SQS_NOTIFICATION_QUEUE_URL not configured — notification dropped');
    return;
  }
  await sqsClient.send(new SendMessageCommand({
    QueueUrl:    env.SQS_NOTIFICATION_QUEUE_URL,
    MessageBody: JSON.stringify(job),
  }));
  logger.debug({ notificationId: job.notificationId, userId: job.userId }, 'Notification enqueued');
};
```

The `SQSClient` is constructed with a conditional `endpoint` override. When `AWS_ENDPOINT` is set (in local development, this points to `http://localhost:9324`), the SDK sends requests to ElasticMQ. When `AWS_ENDPOINT` is not set (production), the SDK resolves the endpoint from the queue URL itself, which is a real AWS SQS endpoint.

The `NotificationJob` interface is the contract between producer and consumer. It is a plain JSON-serializable object: no class instances, no undefined fields, no circular references. When the consumer parses `msg.Body`, it gets back a value matching `NotificationJob` as long as the schema has not changed between the producer writing and the consumer reading. Note that the `notificationId` field is generated by `NotificationService.deliver()` before the job is enqueued — this is the idempotency key that could be used to detect duplicate deliveries.

### 2.7 `SqsConsumer.ts`

```typescript
// src/modules/notifications/SqsConsumer.ts
export class SqsConsumer {
  private running = false;
  private readonly repo = new NotificationRepository();
  private readonly cb   = new CircuitBreaker('notification-service');

  start(): void {
    this.running = true;
    void this.poll();
  }

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
                  await this.repo.save({ /* ... */ });
                  await sqsClient.send(new DeleteMessageCommand({
                    QueueUrl:      env.SQS_NOTIFICATION_QUEUE_URL,
                    ReceiptHandle: msg.ReceiptHandle!,
                  }));
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
```

Key points in the consumer:

**Long polling (`WaitTimeSeconds: 20`).** Instead of repeatedly calling `ReceiveMessage` and getting empty responses when the queue is idle, the consumer tells SQS to hold the connection open for up to 20 seconds and return as soon as a message arrives. This reduces the number of API calls dramatically and lowers cost.

**Batch receive (`MaxNumberOfMessages: 10`).** SQS allows receiving up to 10 messages in a single API call. This amortises the per-call overhead across 10 units of work.

**Concurrency control with `pLimit`.** Messages in a batch are processed concurrently, but `pLimit(CORE_CONSTANTS.CONCURRENCY_LIMIT)` (which is 5) caps the number of concurrent database writes. Without this cap, a batch of 10 messages would issue 10 simultaneous `INSERT` statements against the database, which could saturate the connection pool.

**Circuit-breaker check before database write.** The consumer reads the circuit breaker state before attempting `repo.save()`. If the circuit is OPEN, the consumer deliberately does not delete the message. This means the visibility timeout will eventually expire, the message will reappear in the queue, and the consumer will try again. The message stays safe in the queue until the downstream database recovers.

**Delete only on success.** The `DeleteMessageCommand` is called only after `repo.save()` completes successfully. If `repo.save()` throws, the `catch` block logs the error but does not delete the message. After the visibility timeout (10 seconds, as configured in `elasticmq.conf`), the message reappears and is retried. After 3 retries, it moves to the DLQ.

**Error isolation in the outer catch.** If the entire `ReceiveMessageCommand` call throws (e.g., SQS/ElasticMQ itself is unavailable), the outer `catch` block waits 5 seconds before retrying. This prevents a tight error loop from generating thousands of log entries per second.

### 2.8 `NotificationService.ts` — Tying It All Together

```typescript
// src/modules/notifications/NotificationService.ts
export class NotificationService {
  private readonly cb   = new CircuitBreaker('notification-service');
  private readonly repo = new NotificationRepository();

  constructor() {
    this.subscribeToEvents();
  }

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
  }

  async deliver(data: { userId: string; type: NotifType; entityType: string; entityId: string; message: string; }): Promise<void> {
    const notificationId = randomUUID();

    try {
      await this.cb.execute(async () => {
        const saved = await this.repo.save({ ...data, read: false });
        logger.debug({ notificationId: saved.id, userId: data.userId }, 'Notification delivered');
      });
    } catch (err) {
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
}
```

`NotificationService` is constructed once at application startup. Its constructor calls `subscribeToEvents()`, which registers handlers on the in-process `DomainEventBus`. The `DomainEventBus` is a thin wrapper around Node.js's `EventEmitter`, typed to accept only known `AppDomainEvent` subtypes. This means the notification system is event-driven without any polling.

The `deliver` method has a clear two-path design:

- **Happy path**: `this.cb.execute()` wraps `this.repo.save()`. If the database write succeeds, the notification is persisted and the circuit stays CLOSED.
- **Fallback path**: If `cb.execute()` throws (either because the circuit is OPEN, or because `repo.save()` threw and the failure count reached the threshold), the `catch` block calls `enqueueNotification()`. The notification is placed in SQS for eventual delivery by the consumer.

Notice that the fallback itself has a `.catch()` handler. If SQS is also unavailable (both the database and the queue are down simultaneously), the notification is dropped but the error is logged. The system degrades gracefully: it does not crash, does not block the caller, and records evidence in the log.

---

### 2.9 End-to-End Trace: A User Is @Mentioned in a Comment

```
User submits POST /issues/:id/comments with body containing "@alice"
│
├─ CommentService.create() extracts mentions = ['alice-uuid'] from body text
├─ CommentService.create() saves comment to database
├─ CommentService.create() calls eventBus.publish({ type: 'CommentAdded', payload: { commentId, issueId, mentions: ['alice-uuid'] } })
│
│  [DomainEventBus dispatches the event to all subscribers]
│
├─ NotificationService handler fires (subscribed to 'CommentAdded')
│   └─ for mentionedUserId = 'alice-uuid':
│       └─ NotificationService.deliver({ userId: 'alice-uuid', type: MENTIONED, entityType: 'COMMENT', ... })
│
│           CASE A: Circuit is CLOSED (normal)
│           ├─ CircuitBreaker.execute() calls repo.save()
│           ├─ Notification row written to `notifications` table
│           └─ Alice's notification bell shows new notification on next poll
│
│           CASE B: Circuit is OPEN (database down)
│           ├─ CircuitBreaker.execute() throws immediately (no DB call attempted)
│           ├─ catch block calls enqueueNotification({ notificationId, userId: 'alice-uuid', ... })
│           ├─ SqsProducer sends SendMessageCommand to ElasticMQ/SQS
│           └─ Message sits in `notification-delivery` queue
│
│               [later, when database recovers and circuit closes]
│               ├─ SqsConsumer.poll() receives message via ReceiveMessageCommand
│               ├─ cbState is now CLOSED
│               ├─ repo.save() writes notification row to database
│               ├─ DeleteMessageCommand removes message from queue
│               └─ Alice's notification bell shows new notification on next poll
│
│           CASE C: Circuit is OPEN and SQS is also unavailable
│           ├─ CircuitBreaker.execute() throws
│           ├─ catch block calls enqueueNotification()
│           ├─ enqueueNotification() throws (SQS unavailable)
│           ├─ Inner .catch() logs the error
│           └─ Notification is dropped (Alice does not receive it)
│
└─ POST /issues/:id/comments returns 201 Created to the user
   (all of the above happened asynchronously, the response was not blocked)
```

The response is returned before any notification processing completes. This is the fundamental benefit of the event-driven, asynchronous design.

---

## Key Takeaways

- A message queue decouples a producer from a consumer in time and availability. The producer returns immediately after writing to the queue; the consumer processes at its own pace without affecting API latency.
- SQS guarantees at-least-once delivery. The visibility timeout is the mechanism that enables retries without explicit retry code: if a consumer does not delete a message within the timeout, SQS makes it visible again automatically.
- Dead-letter queues quarantine poison-pill messages (those that repeatedly fail processing) away from the main queue, preventing them from blocking healthy messages.
- The Circuit Breaker pattern has three states: CLOSED (normal), OPEN (fast-fail), and HALF_OPEN (probe). The transition CLOSED → OPEN is driven by a failure count threshold; OPEN → HALF_OPEN is driven by a timeout; HALF_OPEN → CLOSED is driven by a successful probe.
- Circuit breaker state must be stored in a shared external store (Redis in this codebase) so that all application pods share the same view of whether the circuit is open. Per-pod in-memory state is insufficient in a multi-instance deployment.
- The `CircuitBreaker` in this codebase represents the OPEN state as a Redis key with a TTL. The HALF_OPEN probe is implicit: the first request after the key expires acts as the probe. This is a deliberate simplification; a stricter implementation would use atomic Redis operations to allow exactly one concurrent probe.
- ElasticMQ provides a local SQS-compatible server with identical API semantics, allowing development and testing without real AWS credentials, network latency, or cost.
- The `SqsConsumer` uses long polling (`WaitTimeSeconds: 20`) to minimise unnecessary API calls and `pLimit` to cap concurrent database writes, protecting the connection pool from batch spikes.

---

## Further Reading

- **"Release It!" by Michael T. Nygard (2nd edition, 2018)** — The canonical book on stability patterns in distributed systems. Chapter 5 covers Circuit Breaker in depth alongside related patterns such as Bulkhead and Timeouts.
- **Martin Fowler, "CircuitBreaker" (martinfowler.com, 2014)** — A concise article by Martin Fowler that defines the pattern and walks through a Ruby implementation. The state machine diagram in this article is the reference most implementations follow.
- **AWS SQS Developer Guide: "Amazon SQS visibility timeout"** — The official AWS documentation page explaining visibility timeout mechanics, extension via `ChangeMessageVisibility`, and guidance on choosing the correct timeout value for your use case.
- **AWS SQS Developer Guide: "Amazon SQS dead-letter queues"** — Explains how dead-letter queues work, how `maxReceiveCount` is calculated, and how to redrive messages from a DLQ back to the source queue after fixing the root cause.
- **"Designing Distributed Systems" by Brendan Burns (O'Reilly, 2018)** — Burns (one of the creators of Kubernetes) covers producer/consumer patterns, work queues, and scatter/gather patterns with worked examples. Chapter 7 covers batch computational patterns and is directly relevant to queue-based architectures.
