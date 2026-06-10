/** Encode a cursor value to base64url (opaque to clients) */
export const encodeCursor = (value: string): string =>
  Buffer.from(value).toString('base64url');

/** Decode a base64url cursor back to its raw string value */
export const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, 'base64url').toString('utf8');
