export interface PaginationParams {
  readonly cursor?: string;
  readonly limit: number;
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Encode a cursor from a field value (base64url) */
export const encodeCursor = (value: string): string =>
  Buffer.from(value).toString('base64url');

/** Decode a cursor back to its raw value */
export const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, 'base64url').toString('utf8');
