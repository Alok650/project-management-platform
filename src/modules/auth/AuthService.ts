import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { randomUUID } from 'crypto';
import { omit } from 'lodash';
import { UserRepository } from './UserRepository';
import { redis } from '../../config/redis';
import { CacheKeys } from '../../infrastructure/cache/CacheKeys';
import { env } from '../../config/env';
import { UnauthorizedError, ConflictError } from '../../core/errors/errors';
import type { User } from '../../models/User';
import type { LoginResult } from './interfaces';

const BCRYPT_ROUNDS = 12;

/** Handles user registration and JWT-based authentication */
export class AuthService {
  constructor(private readonly userRepo: UserRepository) {}

  /**
   * Register a new user account.
   * @throws {ConflictError} If email is already registered
   */
  async register(email: string, displayName: string, password: string): Promise<Omit<User, 'passwordHash'>> {
    const existing = await this.userRepo.findByEmail(email);
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.userRepo.save({ email, displayName, passwordHash });
    return omit(user, ['passwordHash']);
  }

  /**
   * Authenticate with email + password, returns a signed JWT.
   * @throws {UnauthorizedError} If credentials are invalid
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.userRepo.findByEmail(email);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const jti = randomUUID();
    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, jti },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN as StringValue },
    );

    return { accessToken, user: omit(user, ['passwordHash']) };
  }

  /**
   * Revoke a JWT by blacklisting its jti in Redis until the token naturally expires.
   * @param jti - Token ID claim from the JWT payload
   * @param exp - Token expiry (Unix seconds) from the JWT payload
   */
  async logout(jti: string, exp: number): Promise<void> {
    const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 1);
    await redis.setex(CacheKeys.jwtRevoked(jti), ttl, '1');
  }
}
