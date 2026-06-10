import { Middleware } from 'koa';
import { ProjectRole } from '../types/enums';
import { ForbiddenError } from '../errors/errors';
import { AppDataSource } from '../../config/database';
import { ProjectMember } from '../../models/ProjectMember';
import { membershipCache } from '../../infrastructure/cache/MembershipCache';

const roleRank: Record<ProjectRole, number> = {
  [ProjectRole.ADMIN]: 4,
  [ProjectRole.PROJECT_LEAD]: 3,
  [ProjectRole.MEMBER]: 2,
  [ProjectRole.VIEWER]: 1,
};

/**
 * Middleware factory that enforces a minimum project role.
 * Reads projectId from ctx.params.projectId.
 *
 * Role is served from MembershipCache (5-min TTL) to avoid a DB hit on every
 * project-scoped request.  The cache is invalidated by ProjectService on any
 * addMember / removeMember / updateMemberRole call.
 *
 * @param minRole - Minimum required role for the action
 */
export const requireProjectRole = (minRole: ProjectRole): Middleware =>
  async (ctx, next) => {
    const { projectId } = ctx.params;
    const userId = ctx.state.user.id;

    let role = await membershipCache.get(projectId, userId);

    if (!role) {
      const repo = AppDataSource.getRepository(ProjectMember);
      const membership = await repo.findOne({ where: { projectId, userId } });

      if (!membership) throw new ForbiddenError('access', 'this project');

      role = membership.role;
      membershipCache.set(projectId, userId, role).catch(() => {});
    }

    if (roleRank[role] < roleRank[minRole]) {
      throw new ForbiddenError(`perform this action (requires ${minRole})`, 'this project');
    }

    ctx.state.projectRole = role;
    await next();
  };
