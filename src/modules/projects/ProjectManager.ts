import { ProjectService } from './ProjectService';
import { ProjectRepository } from './ProjectRepository';
import { ProjectRole } from '../../core/types/enums';

/** Thin orchestration layer for the projects module */
export class ProjectManager {
  private readonly service: ProjectService;

  constructor() {
    this.service = new ProjectService(new ProjectRepository());
  }

  /** @see ProjectService.create */
  create(data: { name: string; key: string; description?: string }, createdById: string) {
    return this.service.create({ ...data, createdById });
  }

  /** @see ProjectService.getById */
  get(id: string, userId: string)                                                             { return this.service.getById(id, userId); }

  /** @see ProjectService.listForUser */
  list(userId: string)                                                                         { return this.service.listForUser(userId); }

  /** @see ProjectService.update */
  update(id: string, data: { name?: string; description?: string })                          { return this.service.update(id, data); }

  /** @see ProjectService.delete */
  delete(id: string)                                                                           { return this.service.delete(id); }

  /** @see ProjectService.addMember */
  addMember(projectId: string, userId: string, role: ProjectRole)                            { return this.service.addMember(projectId, userId, role); }

  /** @see ProjectService.updateMemberRole */
  updateMemberRole(projectId: string, userId: string, role: ProjectRole)                    { return this.service.updateMemberRole(projectId, userId, role); }

  /** @see ProjectService.removeMember */
  removeMember(projectId: string, userId: string)                                            { return this.service.removeMember(projectId, userId); }

  /** @see ProjectService.listMembers */
  listMembers(projectId: string)                                                              { return this.service.listMembers(projectId); }
}
