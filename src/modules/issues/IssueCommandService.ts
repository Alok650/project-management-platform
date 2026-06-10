import { AppDataSource } from '../../config/database';
import { IssueRepository } from './IssueRepository';
import { IssueKeyGenerator } from './IssueKeyGenerator';
import { ProjectRepository } from '../projects/ProjectRepository';
import { WorkflowRepository } from '../workflow/WorkflowRepository';
import { WorkflowEngine } from '../workflow/WorkflowEngine';
import { eventBus } from '../../core/events/DomainEventBus';
import { NotFoundError, ConflictError } from '../../core/errors/errors';
import { Issue } from '../../models/Issue';
import { StatusCategory } from '../../core/types/enums';
import type { IssueCreatedEvent, IssueUpdatedEvent, IssueMovedEvent } from '../../core/events/events';
import { omit } from 'lodash';

/** CQRS write path: all issue mutation operations */
export class IssueCommandService {
  private readonly keyGen         = new IssueKeyGenerator();
  private readonly workflowEngine = new WorkflowEngine();

  constructor(
    private readonly issueRepo:    IssueRepository,
    private readonly projectRepo:  ProjectRepository,
    private readonly workflowRepo: WorkflowRepository,
  ) {}

  /**
   * Create a new issue in a project.
   * Generates an issue key atomically, defaults statusId to first TODO status if omitted.
   *
   * @param projectId - Target project UUID
   * @param data - Issue fields
   * @param actorId - User creating the issue
   * @param correlationId - Request correlation ID
   */
  async create(
    projectId: string,
    data: Partial<Issue> & { type: string; title: string },
    actorId: string,
    correlationId: string,
  ): Promise<Issue> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) throw new NotFoundError('Project', projectId);

    let { statusId } = data;
    if (!statusId) {
      const statuses = await this.workflowRepo.findStatusesByProject(projectId);
      const todo = statuses.find((s) => s.category === StatusCategory.TODO);
      if (!todo) throw new NotFoundError('WorkflowStatus (TODO category)', projectId);
      statusId = todo.id;
    }

    const issueKey = await this.keyGen.next(projectId, project.key);
    const issue = await this.issueRepo.save({
      ...data,
      projectId,
      statusId,
      issueKey,
      reporterId: actorId,
      labels: (data.labels as string[] | undefined) ?? [],
    } as Partial<Issue>);

    eventBus.publish({
      type: 'IssueCreated',
      occurredAt: new Date(),
      correlationId,
      payload: { issueId: issue.id, projectId, actorId },
    } as IssueCreatedEvent);

    return issue;
  }

  /**
   * Update issue fields with optimistic locking.
   * Caller must send the current `version`; a mismatch yields 409 ConflictError.
   *
   * @param issueId - UUID of the issue to update
   * @param data - Fields to change, plus current version
   * @param actorId - User making the change
   * @param correlationId - Request correlation ID
   * @throws {ConflictError} On version mismatch
   */
  async update(
    issueId: string,
    data: Partial<Issue> & { version: number },
    actorId: string,
    correlationId: string,
  ): Promise<Issue> {
    const issue = await this.issueRepo.findById(issueId);
    if (!issue) throw new NotFoundError('Issue', issueId);

    const changes = omit(data, ['version']) as Partial<Issue>;
    const sprintChanged = 'sprintId' in changes && changes.sprintId !== issue.sprintId;
    const fromSprintId = issue.sprintId;

    try {
      const updated = await AppDataSource.transaction(async (em) => {
        return em.save(Issue, { ...issue, ...changes, version: data.version });
      });

      eventBus.publish({
        type: 'IssueUpdated',
        occurredAt: new Date(),
        correlationId,
        payload: { issueId, projectId: issue.projectId, changes: changes as Record<string, unknown>, actorId },
      } as IssueUpdatedEvent);

      if (sprintChanged) {
        eventBus.publish({
          type: 'IssueMoved',
          occurredAt: new Date(),
          correlationId,
          payload: { issueId, projectId: issue.projectId, fromSprintId, toSprintId: updated.sprintId, actorId },
        } as IssueMovedEvent);
      }

      return updated;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'OptimisticLockVersionMismatchError') {
        const current = await this.issueRepo.findById(issueId);
        throw new ConflictError(
          'Issue was modified by another user. Please retry with the latest version.',
          current?.version,
        );
      }
      throw err;
    }
  }

  /**
   * Transition an issue to a new workflow status.
   * Returns both the updated issue and the pre-transition statusId so the
   * manager layer can perform a precise ZREM+ZADD on the status index.
   */
  async transition(
    issueId: string,
    toStatusId: string,
    actorId: string,
    correlationId: string,
  ): Promise<{ issue: Issue; fromStatusId: string }> {
    const issue = await this.issueRepo.findById(issueId, ['status']);
    if (!issue) throw new NotFoundError('Issue', issueId);
    const fromStatusId = issue.statusId;
    const updated = await this.workflowEngine.transition(issue, toStatusId, actorId, correlationId);
    return { issue: updated, fromStatusId };
  }

  /**
   * Soft-delete an issue and return it so callers can clean up derived caches.
   * Returning the pre-delete snapshot avoids an extra fetch in the manager layer.
   */
  async delete(issueId: string): Promise<Issue> {
    const issue = await this.issueRepo.findById(issueId);
    if (!issue) throw new NotFoundError('Issue', issueId);
    await this.issueRepo.softDelete(issueId);
    return issue;
  }
}
