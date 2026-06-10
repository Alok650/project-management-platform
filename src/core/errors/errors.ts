import { AppError } from './AppError';

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', 404, `${resource} '${id}' not found`);
  }
}
export class ConflictError extends AppError {
  constructor(message: string, public readonly currentVersion?: number) {
    super('CONFLICT', 409, message, { currentVersion });
  }
}
export class ValidationError extends AppError {
  constructor(message: string, public readonly fields?: Record<string, string>) {
    super('VALIDATION_ERROR', 400, message, { fields });
  }
}
export class ForbiddenError extends AppError {
  constructor(action: string, resource: string) {
    super('FORBIDDEN', 403, `Not allowed to ${action} ${resource}`);
  }
}
export class UnprocessableError extends AppError {
  constructor(message: string, public readonly allowedTransitions?: string[]) {
    super('UNPROCESSABLE', 422, message, { allowedTransitions });
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', 401, message);
  }
}
