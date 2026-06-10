export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Wrap a result in the standard API envelope */
export const ok = <T>(data: T, meta?: Record<string, unknown>): ApiResponse<T> => ({ data, meta });
