import { SprintService } from './SprintService';
import { SprintRepository } from './SprintRepository';

/** Thin orchestration layer for sprint operations */
export class SprintManager {
  private readonly service: SprintService;

  constructor() {
    this.service = new SprintService(new SprintRepository());
  }

  /** List all sprints for a project */
  list(projectId: string)                                              { return this.service.list(projectId); }

  /** Create a new sprint in PLANNING status */
  create(projectId: string, data: Parameters<SprintService['create']>[1]) { return this.service.create(projectId, data); }

  /** Start a sprint, acquiring an advisory lock to prevent concurrent starts */
  start(sprintId: string, actorId: string, correlationId: string)     { return this.service.start(sprintId, actorId, correlationId); }

  /** Complete a sprint, computing velocity and handling carry-over issues */
  complete(sprintId: string, carryOverIssueIds: string[], nextSprintId: string | undefined, actorId: string, correlationId: string) {
    return this.service.complete(sprintId, carryOverIssueIds, nextSprintId, actorId, correlationId);
  }
}
