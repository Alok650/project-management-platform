import { AuthService } from './AuthService';
import { UserRepository } from './UserRepository';

/** Orchestration layer for auth operations */
export class AuthManager {
  private readonly authService: AuthService;

  constructor() {
    const userRepo = new UserRepository();
    this.authService = new AuthService(userRepo);
  }

  /** @see AuthService.register */
  register(email: string, displayName: string, password: string) {
    return this.authService.register(email, displayName, password);
  }

  /** @see AuthService.login */
  login(email: string, password: string) {
    return this.authService.login(email, password);
  }

  /** @see AuthService.logout */
  logout(jti: string, exp: number) {
    return this.authService.logout(jti, exp);
  }
}
