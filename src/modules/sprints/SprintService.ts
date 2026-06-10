import { AppDataSource } from '../../config/database';
import { SprintRepository } from './SprintRepository';
import { eventBus } from '../../core/events/DomainEventBus';
import { NotFoundError, ConflictError, UnprocessableError } from '../../core/errors/errors';
import { SprintStatus } from '../../core/types/enums';
import { Issue } from '../../models/Issue';
import { Sprint } from '../../models/Sprint';
import { SPRINT_CONSTANTS } from './constants';
import { redisCache } from '../../infrastructure/cache/RedisCache';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { CACHE_TTL } from '../../infrastructure/cache/constants';
import type { SprintUpdatedEvent } from '../../core/events/events';

/** Business logic for sprint lifecycle management with advisory locks */
export class SprintService {
  constructor(private readonly repo: SprintRepository) {}

  /**
   * List all sprints for a project.
   * Cached for SPRINT_LIST_SECONDS; invalidated on create/start/complete.
   */
  async list(projectId: string): Promise<Sprint[]> {
    const cached = await redisCache.get<Sprint[]>(CacheKeys.sprintList(projectId));
    if (cached) return cached;

    const sprints = await this.repo.findByProject(projectId);
    redisCache.set(CacheKeys.sprintList(projectId), sprints, CACHE_TTL.SPRINT_LIST_SECONDS).catch(() => {});
    return sprints;
  }

  /**
   * Create a new sprint in PLANNING status.
   * Invalidates sprint list cache.
   */
  async create(
    projectId: string,
    data: { name: string; goal?: string; startDate?: string; endDate?: string },
  ): Promise<Sprint> {
    const sprint = await this.repo.save({ ...data, projectId, status: SprintStatus.PLANNING });
    redisCache.del(CacheKeys.sprintList(projectId)).catch(() => {});
    return sprint;
  }

  /**
   * Start a sprint using a MySQL advisory lock to prevent concurrent starts.
   * Only one ACTIVE sprint is allowed per project at a time.
   * Invalidates sprint list cache.
   *
   * @throws {NotFoundError} If sprint does not exist
   * @throws {ConflictError} If sprint is already started or another is active
   */
  async start(sprintId: string, actorId: string, correlationId: string): Promise<Sprint> {
    const sprint = await AppDataSource.transaction(async (em) => {
      await em.query(`SELECT GET_LOCK(?, ?)`, [`sprint-start-${sprintId}`, SPRINT_CONSTANTS.ADVISORY_LOCK_TIMEOUT_SECONDS]);
      try {
        const found = await this.repo.findById(sprintId);
        if (!found) throw new NotFoundError('Sprint', sprintId);
        if (found.status !== SprintStatus.PLANNING) throw new ConflictError('Sprint is already started or completed');

        const activeExists = await this.repo.findActive(found.projectId);
        if (activeExists) throw new ConflictError('A sprint is already active for this project');

        const startDate = found.startDate ?? new Date().toISOString().slice(0, 10);
        const updated   = await em.save(Sprint, { ...found, status: SprintStatus.ACTIVE, startDate });

        eventBus.publish({
          type: 'SprintUpdated',
          occurredAt: new Date(),
          correlationId,
          payload: { sprintId, projectId: found.projectId, actorId },
        } as SprintUpdatedEvent);

        return updated;
      } finally {
        await em.query(`SELECT RELEASE_LOCK(?)`, [`sprint-start-${sprintId}`]);
      }
    });

    redisCache.del(CacheKeys.sprintList(sprint.projectId)).catch(() => {});
    return sprint;
  }

  /**
   * Complete a sprint with selective carry-over of incomplete issues.
   * Uses advisory lock to prevent concurrent completions.
   * Invalidates sprint list cache.
   *
   * @param sprintId - Sprint to complete
   * @param carryOverIssueIds - IDs of incomplete issues to move to nextSprintId (or backlog if null)
   * @param nextSprintId - Destination sprint for carry-over issues; null = backlog
   * @param actorId - User completing the sprint
   * @param correlationId - Request correlation ID
   * @returns Object with updated sprint and count of incomplete issues
   */
  async complete(
    sprintId: string,
    carryOverIssueIds: string[],
    nextSprintId: string | undefined,
    actorId: string,
    correlationId: string,
  ): Promise<{ sprint: Sprint; incompleteCount: number }> {
    const result = await AppDataSource.transaction(async (em) => {
      await em.query(`SELECT GET_LOCK(?, ?)`, [`sprint-complete-${sprintId}`, SPRINT_CONSTANTS.ADVISORY_LOCK_TIMEOUT_SECONDS]);
      try {
        const sprint = await this.repo.findById(sprintId);
        if (!sprint) throw new NotFoundError('Sprint', sprintId);
        if (sprint.status !== SprintStatus.ACTIVE) throw new UnprocessableError('Only ACTIVE sprints can be completed');

        const velocity      = await this.repo.getVelocity(sprintId);
        const completedSprint = await em.save(Sprint, { ...sprint, status: SprintStatus.COMPLETED, velocity });

        const incomplete = await this.repo.getIncompleteIssues(sprintId);
        const carrySet   = new Set(carryOverIssueIds);

        for (const issue of incomplete) {
          await em.getRepository(Issue).update(
            { id: issue.id },
            { sprintId: carrySet.has(issue.id) ? (nextSprintId ?? null) : null },
          );
        }

        eventBus.publish({
          type: 'SprintUpdated',
          occurredAt: new Date(),
          correlationId,
          payload: { sprintId, projectId: sprint.projectId, actorId },
        } as SprintUpdatedEvent);

        return { sprint: completedSprint, incompleteCount: incomplete.length };
      } finally {
        await em.query(`SELECT RELEASE_LOCK(?)`, [`sprint-complete-${sprintId}`]);
      }
    });

    redisCache.del(CacheKeys.sprintList(result.sprint.projectId)).catch(() => {});
    return result;
  }
}
