import { WorkflowRepository } from './WorkflowRepository';
import { NotFoundError } from '../../core/errors/errors';
import type { WorkflowStatus } from '../../models/WorkflowStatus';
import type { WorkflowTransition } from '../../models/WorkflowTransition';
import { StatusCategory } from '../../core/types/enums';

/** CRUD service for workflow statuses and transitions */
export class WorkflowService {
  constructor(private readonly repo: WorkflowRepository) {}

  /** Get all workflow statuses for a project, ordered by position */
  getStatuses(projectId: string): Promise<WorkflowStatus[]> {
    return this.repo.findStatusesByProject(projectId);
  }

  /** Create a new workflow status */
  createStatus(data: {
    projectId: string;
    name: string;
    category: StatusCategory;
    position?: number;
    wipLimit?: number | null;
  }): Promise<WorkflowStatus> {
    return this.repo.saveStatus(data as Partial<WorkflowStatus>);
  }

  /** Update name, position, or WIP limit on an existing status */
  async updateStatus(
    id: string,
    data: Partial<{ name: string; position: number; wipLimit: number | null }>,
  ): Promise<WorkflowStatus> {
    const status = await this.repo.findStatusById(id);
    if (!status) throw new NotFoundError('WorkflowStatus', id);
    return this.repo.saveStatus({ ...status, ...data });
  }

  /** List allowed transitions from a given status */
  getAllowedTransitions(fromStatusId: string): Promise<WorkflowTransition[]> {
    return this.repo.findAllowedTransitions(fromStatusId);
  }

  /** Create an allowed status transition */
  createTransition(data: {
    projectId: string;
    fromStatusId: string;
    toStatusId: string;
    name?: string;
  }): Promise<WorkflowTransition> {
    return this.repo.saveTransition(data as Partial<WorkflowTransition>);
  }
}
