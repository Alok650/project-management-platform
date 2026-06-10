import { Context } from 'koa';
import { ProjectManager } from './ProjectManager';
import { ok } from '../../core/types/ApiResponse';
import { ProjectRole } from '../../core/types/enums';

const manager = new ProjectManager();

/** HTTP handler layer for project endpoints */
export class ProjectController {
  /** POST /api/v1/projects — create a new project */
  static async create(ctx: Context): Promise<void> {
    const body = ctx.request.body as { name: string; key: string; description?: string };
    const project = await manager.create(body, ctx.state.user.id);
    ctx.status = 201;
    ctx.body = ok(project);
  }

  /** GET /api/v1/projects — list projects for the authenticated user */
  static async list(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.list(ctx.state.user.id));
  }

  /** GET /api/v1/projects/:projectId — get a single project */
  static async get(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.get(ctx.params['projectId']!, ctx.state.user.id));
  }

  /** PATCH /api/v1/projects/:projectId — update project metadata */
  static async update(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.update(ctx.params['projectId']!, ctx.request.body as any));
  }

  /** DELETE /api/v1/projects/:projectId — soft-delete a project */
  static async delete(ctx: Context): Promise<void> {
    await manager.delete(ctx.params['projectId']!);
    ctx.status = 204;
  }

  /** POST /api/v1/projects/:projectId/members — add a member */
  static async addMember(ctx: Context): Promise<void> {
    const { userId, role } = ctx.request.body as { userId: string; role: string };
    const member = await manager.addMember(ctx.params['projectId']!, userId, role as ProjectRole);
    ctx.status = 201;
    ctx.body = ok(member);
  }

  /** GET /api/v1/projects/:projectId/members — list project members */
  static async listMembers(ctx: Context): Promise<void> {
    ctx.body = ok(await manager.listMembers(ctx.params['projectId']!));
  }

  /** DELETE /api/v1/projects/:projectId/members/:userId — remove a member */
  static async removeMember(ctx: Context): Promise<void> {
    await manager.removeMember(ctx.params['projectId']!, ctx.params['userId']!);
    ctx.status = 204;
  }
}
