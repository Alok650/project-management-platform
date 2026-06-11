import { Context } from 'koa';
import { AuthManager } from './AuthManager';
import { ok } from '../../core/types/ApiResponse';

const manager = new AuthManager();

/** HTTP handler layer for authentication endpoints */
export class AuthController {
  /** POST /api/v1/auth/register */
  static async register(ctx: Context): Promise<void> {
    const { email, displayName, password } = ctx.request.body as { email: string; displayName: string; password: string };
    const user = await manager.register(email, displayName, password);
    ctx.status = 201;
    ctx.body = ok(user);
  }

  /** POST /api/v1/auth/login */
  static async login(ctx: Context): Promise<void> {
    const { email, password } = ctx.request.body as { email: string; password: string };
    const result = await manager.login(email, password);
    ctx.body = ok(result);
  }

  /** POST /api/v1/auth/logout */
  static async logout(ctx: Context): Promise<void> {
    await manager.logout((ctx.state as any).jti, (ctx.state as any).exp);
    ctx.status = 204;
  }
}
