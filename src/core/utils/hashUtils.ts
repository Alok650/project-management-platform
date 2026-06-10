import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/** Hash a plain-text password using bcrypt */
export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, SALT_ROUNDS);

/** Compare a plain-text password against a stored hash */
export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);
