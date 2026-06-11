/**
 * Unit tests for AuthService — register, login, and logout flows.
 *
 * All external collaborators (UserRepository, bcrypt, jwt, env) are mocked
 * at module level so no real DB or process.env is needed.
 */

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

jest.mock('../../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'supersecretkey_that_is_at_least_32chars',
    JWT_EXPIRES_IN: '7d',
    DB_HOST: 'localhost',
    DB_PORT: 3306,
    DB_NAME: 'testdb',
    DB_USER: 'user',
    DB_PASSWORD: 'pass',
    DB_POOL_MAX: 5,
    REDIS_URL: 'redis://localhost:6379',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_NOTIFICATION_QUEUE_URL: 'http://localhost/queue',
    LOG_LEVEL: 'info',
  },
}));

jest.mock('../../../src/config/database', () => ({
  AppDataSource: {
    getRepository: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../../../src/core/events/DomainEventBus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn(),
  },
}));

const mockBcryptHash    = jest.fn();
const mockBcryptCompare = jest.fn();

jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: {
    hash:    (...args: unknown[]) => mockBcryptHash(...args),
    compare: (...args: unknown[]) => mockBcryptCompare(...args),
  },
}));

const mockRedisSetex = jest.fn();

jest.mock('../../../src/config/redis', () => ({
  redis: { setex: (...args: unknown[]) => mockRedisSetex(...args) },
}));

const mockJwtSign   = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    sign:   (...args: unknown[]) => mockJwtSign(...args),
    verify: (...args: unknown[]) => mockJwtVerify(...args),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AuthService }    from '../../../src/modules/auth/AuthService';
import { UserRepository } from '../../../src/modules/auth/UserRepository';
import { ConflictError, UnauthorizedError } from '../../../src/core/errors/errors';
import type { User } from '../../../src/models/User';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id:           'user-uuid-1',
    email:        'alice@example.com',
    displayName:  'Alice',
    passwordHash: 'hashed_password_value',
    createdAt:    new Date('2024-01-01T00:00:00Z'),
    updatedAt:    new Date('2024-01-01T00:00:00Z'),
    memberships:  [],
    ...overrides,
  } as User;
}

function makeRepoMock(): jest.Mocked<UserRepository> {
  return {
    findByEmail: jest.fn(),
    findById:    jest.fn(),
    save:        jest.fn(),
  } as unknown as jest.Mocked<UserRepository>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let repo: jest.Mocked<UserRepository>;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    repo    = makeRepoMock();
    service = new AuthService(repo);
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe('register', () => {
    it('happy path — saves user with hashed password and returns user without passwordHash', async () => {
      const hashedPw = 'bcrypt_hashed_value';
      const savedUser = makeUser({ passwordHash: hashedPw });

      repo.findByEmail.mockResolvedValue(null);
      mockBcryptHash.mockResolvedValue(hashedPw);
      repo.save.mockResolvedValue(savedUser);

      const result = await service.register('alice@example.com', 'Alice', 'plain_password');

      // bcrypt.hash called with the raw password and correct rounds
      expect(mockBcryptHash).toHaveBeenCalledWith('plain_password', 12);

      // repo.save called with hashed password, not raw
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: hashedPw }),
      );
      expect(repo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ password: expect.anything() }),
      );

      // passwordHash must not appear in the returned object
      expect(result).not.toHaveProperty('passwordHash');
      expect(result.email).toBe('alice@example.com');
      expect(result.displayName).toBe('Alice');
    });

    it('duplicate email — throws ConflictError when email already exists', async () => {
      repo.findByEmail.mockResolvedValue(makeUser());

      await expect(
        service.register('alice@example.com', 'Alice', 'password123'),
      ).rejects.toThrow(ConflictError);

      // No save attempted
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ── login ────────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('correct password — returns accessToken and user without passwordHash', async () => {
      const user = makeUser();
      repo.findByEmail.mockResolvedValue(user);
      mockBcryptCompare.mockResolvedValue(true);
      mockJwtSign.mockReturnValue('signed.jwt.token');

      const result = await service.login('alice@example.com', 'correct_password');

      expect(mockBcryptCompare).toHaveBeenCalledWith('correct_password', user.passwordHash);
      expect(mockJwtSign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: user.id, email: user.email }),
        'supersecretkey_that_is_at_least_32chars',
        expect.objectContaining({ expiresIn: '7d' }),
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.user.email).toBe('alice@example.com');
    });

    it('wrong password — throws UnauthorizedError', async () => {
      const user = makeUser();
      repo.findByEmail.mockResolvedValue(user);
      mockBcryptCompare.mockResolvedValue(false);

      await expect(
        service.login('alice@example.com', 'wrong_password'),
      ).rejects.toThrow(UnauthorizedError);

      // JWT must not be issued on failed auth
      expect(mockJwtSign).not.toHaveBeenCalled();
    });

    it('user not found — throws UnauthorizedError', async () => {
      repo.findByEmail.mockResolvedValue(null);

      await expect(
        service.login('unknown@example.com', 'any_password'),
      ).rejects.toThrow(UnauthorizedError);

      expect(mockBcryptCompare).not.toHaveBeenCalled();
      expect(mockJwtSign).not.toHaveBeenCalled();
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('blacklists jti in Redis with TTL equal to remaining token lifetime', async () => {
      const now = Math.floor(Date.now() / 1000);
      const jti = 'test-jti-uuid-abc';
      const exp = now + 300;

      mockRedisSetex.mockResolvedValue('OK');

      await service.logout(jti, exp);

      expect(mockRedisSetex).toHaveBeenCalledTimes(1);
      const [key, ttl, value] = mockRedisSetex.mock.calls[0];
      expect(key).toContain(jti);
      expect(ttl).toBeGreaterThanOrEqual(1);
      expect(ttl).toBeLessThanOrEqual(300);
      expect(value).toBe('1');
    });

    it('uses minimum TTL of 1 second for already-expired tokens', async () => {
      const jti = 'expired-jti';
      const exp = Math.floor(Date.now() / 1000) - 60;

      mockRedisSetex.mockResolvedValue('OK');

      await service.logout(jti, exp);

      const [, ttl] = mockRedisSetex.mock.calls[0];
      expect(ttl).toBe(1);
    });
  });
});
