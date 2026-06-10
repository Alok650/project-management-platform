import { AppDataSource } from '../../config/database';
import { Project } from '../../models/Project';
import { ProjectMember } from '../../models/ProjectMember';
import { ProjectRole } from '../../core/types/enums';

/** Data access layer for Project and ProjectMember entities */
export class ProjectRepository {
  private readonly projectRepo = AppDataSource.getRepository(Project);
  private readonly memberRepo  = AppDataSource.getRepository(ProjectMember);

  /** Find a project by its UUID primary key */
  findById(id: string): Promise<Project | null> {
    return this.projectRepo.findOne({ where: { id } });
  }

  /** Find a project by its short unique key */
  findByKey(key: string): Promise<Project | null> {
    return this.projectRepo.findOne({ where: { key } });
  }

  /** Returns only projects the user is a member of (row-level security) */
  findAllForUser(userId: string): Promise<Project[]> {
    return this.projectRepo
      .createQueryBuilder('p')
      .innerJoin('p.members', 'm', 'm.userId = :userId', { userId })
      .orderBy('p.createdAt', 'DESC')
      .getMany();
  }

  /** Persist a new or updated Project */
  save(project: Partial<Project>): Promise<Project> {
    return this.projectRepo.save(project);
  }

  /** Soft-delete a project by its UUID */
  softDelete(id: string): Promise<void> {
    return this.projectRepo.softDelete(id).then(() => undefined);
  }

  /** Find a single membership record for a project/user pair */
  findMembership(projectId: string, userId: string): Promise<ProjectMember | null> {
    return this.memberRepo.findOne({ where: { projectId, userId } });
  }

  /** Persist a new or updated ProjectMember */
  saveMember(member: Partial<ProjectMember>): Promise<ProjectMember> {
    return this.memberRepo.save(member);
  }

  /** Hard-delete a membership record */
  removeMember(projectId: string, userId: string): Promise<void> {
    return this.memberRepo.delete({ projectId, userId }).then(() => undefined);
  }

  /** List all members of a project, including their user relation */
  listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.memberRepo.find({ where: { projectId }, relations: ['user'] });
  }
}
