/**
 * Unit tests for ActivityService event → ActivityLog mapping.
 *
 * ActivityRepository and DomainEventBus are fully mocked.
 * The wildcard subscriber handler is captured at construction time so
 * tests can invoke it directly without firing real events.
 */

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

jest.mock('../../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'supersecretkey_that_is_at_least_32chars',
    JWT_EXPIRES_IN: '7d',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_NAME: 'testdb',
    DB_USER: 'user',
    DB_PASSWORD: 'pass',
    DB_POOL_MAX: 5,
    REDIS_URL: 'redis://localhost:6379',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_NOTIFICATION_QUEUE_URL: 'http://localhost/queue',
    LOG_LEVEL: 'info',
  },
}));

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn(),
    transaction:   jest.fn(),
  },
}));

// Capture the subscribe spy so tests can extract the registered handler
const mockSubscribe = jest.fn();

jest.mock('../../../src/core/events/DomainEventBus', () => ({
  eventBus: {
    publish:   jest.fn(),
    subscribe: mockSubscribe,
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { ActivityService }    from '../../../src/modules/activity/ActivityService';
import { ActivityRepository } from '../../../src/modules/activity/ActivityRepository';
import { ActivityAction }     from '../../../src/core/types/enums';
import type { AppDomainEvent } from '../../../src/core/events/events';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRepoMock(): jest.Mocked<ActivityRepository> {
  return { save: jest.fn(), listByProject: jest.fn() } as unknown as jest.Mocked<ActivityRepository>;
}

function baseMeta() {
  return { occurredAt: new Date(), correlationId: 'corr-1' } as const;
}

/** Extracts the wildcard handler registered via eventBus.subscribe('*', handler) */
function captureWildcardHandler(): (event: AppDomainEvent) => Promise<void> {
  const call = mockSubscribe.mock.calls.find(([type]) => type === '*');
  if (!call) throw new Error('No wildcard subscription was registered');
  return call[1] as (event: AppDomainEvent) => Promise<void>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivityService', () => {
  let repo: jest.Mocked<ActivityRepository>;
  let service: ActivityService;
  let handleEvent: (event: AppDomainEvent) => Promise<void>;

  beforeEach(() => {
    jest.clearAllMocks();
    repo    = makeRepoMock();
    service = new ActivityService(repo);
    handleEvent = captureWildcardHandler();
  });

  // ── Subscription registration ────────────────────────────────────────────────

  it('registers a wildcard "*" subscription on the eventBus at construction time', () => {
    expect(mockSubscribe).toHaveBeenCalledWith('*', expect.any(Function));
  });

  // ── IssueCreated ─────────────────────────────────────────────────────────────

  it('IssueCreated — saves ActivityLog with action=CREATED and entityType=ISSUE', async () => {
    const event: AppDomainEvent = {
      type: 'IssueCreated',
      payload: { issueId: 'issue-1', projectId: 'proj-1', actorId: 'user-1' },
      ...baseMeta(),
    };
    repo.save.mockResolvedValue({} as any);

    await handleEvent(event);

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     ActivityAction.CREATED,
        entityType: 'ISSUE',
        entityId:   'issue-1',
        actorId:    'user-1',
        projectId:  'proj-1',
      }),
    );
  });

  // ── StatusChanged ────────────────────────────────────────────────────────────

  it('StatusChanged — saves ActivityLog with action=STATUS_CHANGED and old/newValue statusId', async () => {
    const event: AppDomainEvent = {
      type: 'StatusChanged',
      payload: {
        issueId: 'issue-2', projectId: 'proj-1', actorId: 'user-2',
        fromStatusId: 'status-todo', toStatusId: 'status-done',
      },
      ...baseMeta(),
    };
    repo.save.mockResolvedValue({} as any);

    await handleEvent(event);

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     ActivityAction.STATUS_CHANGED,
        entityType: 'ISSUE',
        entityId:   'issue-2',
        oldValue:   { statusId: 'status-todo' },
        newValue:   { statusId: 'status-done' },
      }),
    );
  });

  // ── IssueUpdated ─────────────────────────────────────────────────────────────

  it('IssueUpdated — saves ActivityLog with action=UPDATED and newValue=changes object', async () => {
    const changes = { title: 'New title', priority: 'HIGH' };
    const event: AppDomainEvent = {
      type: 'IssueUpdated',
      payload: { issueId: 'issue-3', projectId: 'proj-1', actorId: 'user-3', changes },
      ...baseMeta(),
    };
    repo.save.mockResolvedValue({} as any);

    await handleEvent(event);

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action:    ActivityAction.UPDATED,
        entityType: 'ISSUE',
        entityId:  'issue-3',
        newValue:  changes,
      }),
    );
  });

  // ── CommentAdded ─────────────────────────────────────────────────────────────

  it('CommentAdded — saves ActivityLog with entityType=COMMENT, action=COMMENT_ADDED, actorId from authorId', async () => {
    const event: AppDomainEvent = {
      type: 'CommentAdded',
      payload: {
        commentId: 'comment-1', issueId: 'issue-4',
        projectId: 'proj-1', authorId: 'user-4', mentions: [],
      },
      ...baseMeta(),
    };
    repo.save.mockResolvedValue({} as any);

    await handleEvent(event);

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action:     ActivityAction.COMMENT_ADDED,
        entityType: 'COMMENT',
        entityId:   'comment-1',
        actorId:    'user-4',
        projectId:  'proj-1',
      }),
    );
  });

  // ── Unmapped event ───────────────────────────────────────────────────────────

  it('unmapped event type (SprintUpdated) — does NOT call repo.save', async () => {
    const event: AppDomainEvent = {
      type: 'SprintUpdated',
      payload: { sprintId: 'sprint-1', projectId: 'proj-1', actorId: 'user-1' },
      ...baseMeta(),
    };

    await handleEvent(event);

    expect(repo.save).not.toHaveBeenCalled();
  });
});
