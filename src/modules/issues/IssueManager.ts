import { IssueCommandService } from './IssueCommandService';
import { IssueQueryService } from './IssueQueryService';
import { IssueRepository } from './IssueRepository';
import { ProjectRepository } from '../projects/ProjectRepository';
import { WorkflowRepository } from '../workflow/WorkflowRepository';
import { redisCache } from '../../infrastructure/cache/RedisCache';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { issueEntityCache } from '../../infrastructure/cache/IssueEntityCache';
import { issueIndexCache } from '../../infrastructure/cache/IssueIndexCache';
import type { Issue } from '../../models/Issue';

/** Orchestration layer for issues — wires command and query services, maintains caches */
export class IssueManager {
  private readonly commandService: IssueCommandService;
  private readonly queryService:   IssueQueryService;
  private readonly issueRepo:      IssueRepository;

  constructor() {
    const issueRepo    = new IssueRepository();
    const projectRepo  = new ProjectRepository();
    const workflowRepo = new WorkflowRepository();
    this.issueRepo      = issueRepo;
    this.commandService = new IssueCommandService(issueRepo, projectRepo, workflowRepo);
    this.queryService   = new IssueQueryService(issueRepo);
  }

  /** Create issue, invalidate board, and warm sprint+status indexes for the new entry */
  async create(
    projectId: string,
    data: Partial<Issue> & { type: string; title: string },
    actorId: string,
    correlationId: string,
  ): Promise<Issue> {
    const issue = await this.commandService.create(projectId, data, actorId, correlationId);
    await Promise.allSettled([
      redisCache.invalidatePattern(CacheKeys.boardStatePattern(projectId)),
      issueIndexCache.addIssue(issue),
    ]);
    return issue;
  }

  /**
   * Update issue and invalidate board + entity caches.
   * If sprintId changes, the sprint index for the affected sprint is invalidated
   * (rebuilds lazily on the next list/board query).
   */
  async update(
    issueId: string,
    data: Partial<Issue> & { version: number },
    actorId: string,
    correlationId: string,
  ): Promise<Issue> {
    const issue = await this.commandService.update(issueId, data, actorId, correlationId);
    const ops: Promise<unknown>[] = [
      redisCache.invalidatePattern(CacheKeys.boardStatePattern(issue.projectId)),
      issueEntityCache.del(issueId),
    ];
    if ('sprintId' in data) {
      ops.push(issueIndexCache.invalidateSprintIndex(issue.projectId, issue.sprintId ?? null));
    }
    await Promise.allSettled(ops);
    return issue;
  }

  /**
   * Transition issue status.
   * Performs a precise ZREM+ZADD on the status index so board column counts
   * stay accurate without a full index rebuild.
   */
  async transition(
    issueId: string,
    toStatusId: string,
    actorId: string,
    correlationId: string,
  ): Promise<Issue> {
    const { issue, fromStatusId } = await this.commandService.transition(
      issueId,
      toStatusId,
      actorId,
      correlationId,
    );
    await Promise.allSettled([
      redisCache.invalidatePattern(CacheKeys.boardStatePattern(issue.projectId)),
      issueEntityCache.del(issueId),
      issueIndexCache.updateIssueStatus(
        issue.projectId,
        issueId,
        fromStatusId,
        toStatusId,
        new Date(issue.createdAt).getTime(),
      ),
    ]);
    return issue;
  }

  /** Soft-delete issue and remove it from all cache layers */
  async delete(issueId: string): Promise<void> {
    const issue = await this.commandService.delete(issueId);
    await Promise.allSettled([
      redisCache.invalidatePattern(CacheKeys.boardStatePattern(issue.projectId)),
      issueEntityCache.del(issueId),
      issueIndexCache.removeIssue(issue),
    ]);
  }

  /** Get board state for a project + optional sprint */
  getBoard(
    projectId: string,
    sprintId: string | null,
  ): Promise<import('../../read-models/BoardView').BoardView> {
    return this.queryService.getBoardView(projectId, sprintId);
  }

  /** Get a single issue with full relations */
  getById(issueId: string): Promise<Issue> { return this.queryService.getById(issueId); }

  /** List issues with cursor pagination */
  list(
    projectId: string,
    filters: Parameters<IssueQueryService['list']>[1],
    pagination: Parameters<IssueQueryService['list']>[2],
  ) {
    return this.queryService.list(projectId, filters, pagination);
  }

  addWatcher(issueId: string, userId: string)    { return this.issueRepo.addWatcher(issueId, userId); }
  removeWatcher(issueId: string, userId: string) { return this.issueRepo.removeWatcher(issueId, userId); }
}
