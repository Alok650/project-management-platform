import { ProjectRepository } from './ProjectRepository';
import { NotFoundError, ConflictError, ForbiddenError } from '../../core/errors/errors';
import { ProjectRole } from '../../core/types/enums';
import { redisCache } from '../../infrastructure/cache/RedisCache';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { membershipCache } from '../../infrastructure/cache/MembershipCache';
import { CACHE_TTL } from '../../infrastructure/cache/constants';
import type { Project } from '../../models/Project';
import type { ProjectMember } from '../../models/ProjectMember';

/** Business logic for project lifecycle and membership management */
export class ProjectService {
  constructor(private readonly repo: ProjectRepository) {}

  /**
   * Create a new project and assign the creator as ADMIN.
   * Invalidates the creator's project list cache.
   * @throws {ConflictError} If the project key is already taken
   */
  async create(data: { name: string; key: string; description?: string; createdById: string }): Promise<Project> {
    const existing = await this.repo.findByKey(data.key);
    if (existing) throw new ConflictError(`Project key '${data.key}' already exists`);

    const project = await this.repo.save(data);
    await this.repo.saveMember({ projectId: project.id, userId: data.createdById, role: ProjectRole.ADMIN });

    redisCache.del(CacheKeys.projectList(data.createdById)).catch(() => {});
    return project;
  }

  /**
   * Retrieve a project by ID, enforcing membership visibility.
   * @throws {NotFoundError} If the project does not exist
   * @throws {ForbiddenError} If the requesting user is not a member
   */
  async getById(id: string, requestingUserId: string): Promise<Project> {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    const membership = await this.repo.findMembership(id, requestingUserId);
    if (!membership) throw new ForbiddenError('access', 'this project');
    return project;
  }

  /**
   * List all projects visible to the given user.
   * Cached for PROJECT_LIST_SECONDS; invalidated on create/addMember/removeMember.
   */
  async listForUser(userId: string): Promise<Project[]> {
    const cached = await redisCache.get<Project[]>(CacheKeys.projectList(userId));
    if (cached) return cached;

    const projects = await this.repo.findAllForUser(userId);
    redisCache.set(CacheKeys.projectList(userId), projects, CACHE_TTL.PROJECT_LIST_SECONDS).catch(() => {});
    return projects;
  }

  /**
   * Update mutable fields on a project.
   * @throws {NotFoundError} If the project does not exist
   */
  async update(id: string, data: Partial<Pick<Project, 'name' | 'description'>>): Promise<Project> {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    return this.repo.save({ ...project, ...data });
  }

  /**
   * Soft-delete a project.
   * @throws {NotFoundError} If the project does not exist
   */
  async delete(id: string): Promise<void> {
    const project = await this.repo.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    await this.repo.softDelete(id);
  }

  /**
   * Add a user as a project member with the given role.
   * Invalidates project list cache for the new member.
   * @throws {ConflictError} If the user is already a member
   */
  async addMember(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    const existing = await this.repo.findMembership(projectId, userId);
    if (existing) throw new ConflictError('User is already a member of this project');
    const member = await this.repo.saveMember({ projectId, userId, role });
    redisCache.del(CacheKeys.projectList(userId)).catch(() => {});
    return member;
  }

  /**
   * Update the role of an existing member.
   * Invalidates membership role cache so RBAC middleware reflects the change immediately.
   * @throws {NotFoundError} If the membership does not exist
   */
  async updateMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    const member = await this.repo.findMembership(projectId, userId);
    if (!member) throw new NotFoundError('ProjectMember', userId);
    const updated = await this.repo.saveMember({ ...member, role });
    membershipCache.del(projectId, userId).catch(() => {});
    return updated;
  }

  /**
   * Remove a user from a project.
   * Invalidates both membership role cache and the user's project list cache.
   */
  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.repo.removeMember(projectId, userId);
    await Promise.allSettled([
      membershipCache.del(projectId, userId),
      redisCache.del(CacheKeys.projectList(userId)),
    ]);
  }

  /** List all members of a project */
  listMembers(projectId: string) { return this.repo.listMembers(projectId); }
}
