import { DefaultContext, DefaultState } from 'koa';

/** Authenticated user attached to Koa state after JWT verification */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
}

export interface AppState extends DefaultState {
  user: AuthUser;
  correlationId: string;
}

export type AppContext = DefaultContext;
