import { AppDataSource } from '../../config/database';
import { WorkflowStatus } from '../../models/WorkflowStatus';
import { WorkflowTransition } from '../../models/WorkflowTransition';

/** Data access layer for workflow statuses and transitions */
export class WorkflowRepository {
  private readonly statusRepo     = AppDataSource.getRepository(WorkflowStatus);
  private readonly transitionRepo = AppDataSource.getRepository(WorkflowTransition);

  /** Find a single workflow status by its UUID */
  findStatusById(id: string): Promise<WorkflowStatus | null> {
    return this.statusRepo.findOne({ where: { id } });
  }

  /** Find all workflow statuses for a project, ordered by position ascending */
  findStatusesByProject(projectId: string): Promise<WorkflowStatus[]> {
    return this.statusRepo.find({ where: { projectId }, order: { position: 'ASC' } });
  }

  /** Persist a new or updated workflow status */
  saveStatus(data: Partial<WorkflowStatus>): Promise<WorkflowStatus> {
    return this.statusRepo.save(data);
  }

  /** Load transition with toStatus relation (for WIP limit) and autoActions */
  findTransition(fromStatusId: string, toStatusId: string): Promise<WorkflowTransition | null> {
    return this.transitionRepo.findOne({
      where: { fromStatusId, toStatusId },
      relations: ['toStatus', 'autoActions'],
    });
  }

  /** Find all allowed transitions from a given status, including toStatus relation */
  findAllowedTransitions(fromStatusId: string): Promise<WorkflowTransition[]> {
    return this.transitionRepo.find({
      where: { fromStatusId },
      relations: ['toStatus'],
    });
  }

  /** Persist a new or updated workflow transition */
  saveTransition(data: Partial<WorkflowTransition>): Promise<WorkflowTransition> {
    return this.transitionRepo.save(data);
  }
}
