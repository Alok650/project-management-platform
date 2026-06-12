# Authentication & Security

## What You'll Learn

- What a JSON Web Token is structurally, and how to decode and verify one by hand
- The precise difference between authentication (who are you?) and authorisation (what are you allowed to do?)
- How Role-Based Access Control (RBAC) works and why it is preferable to a flat Access Control List at scale
- Why passwords are hashed rather than encrypted, what bcrypt does internally, and why the salt-round count is a deliberate performance trade-off
- Why stateless JWTs are hard to revoke and how Redis blacklisting solves that problem without reintroducing a session store
- What the `jti` claim is, why it must be a globally unique value, and how it anchors revocation
- How a Redis sorted-set sliding-window rate limiter works and why rate limiting is a first-line defence against brute force and denial-of-service attacks
- The correct HTTP semantics of 401 vs. 403 and when to use each

---

## Part 1 — Theory

### 1.1 JSON Web Tokens (JWT)

A JWT is a compact, URL-safe string that encodes a set of claims — statements about a subject — and cryptographically proves they have not been tampered with since they were issued. The format is three Base64URL-encoded segments joined by dots:

```
header.payload.signature
```

#### The three parts

**Header** — a JSON object describing the token type and signing algorithm:

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

`HS256` means HMAC-SHA256: a symmetric algorithm where the same secret is used to sign and verify.

**Payload** — the claims. Standard (registered) claims have short names reserved by RFC 7519:

```json
{
  "sub": "a3f9e1b2-...",
  "email": "alice@example.com",
  "jti": "c9d4e7f1-0123-4567-89ab-cdef01234567",
  "iat": 1748700000,
  "exp": 1748786400
}
```

| Claim | Meaning |
|-------|---------|
| `sub` | Subject — the user's unique identifier |
| `iat` | Issued-at — Unix timestamp of creation |
| `exp` | Expiry — Unix timestamp after which the token is invalid |
| `jti` | JWT ID — a unique identifier for this specific token instance |

**Signature** — computed as:

```
HMAC-SHA256(
  base64url(header) + "." + base64url(payload),
  secret
)
```

The server re-derives this on every request. If even one character in the header or payload has changed, the signature will not match. This is why JWTs are *tamper-evident*: without the server's secret, an attacker cannot forge a valid token.

#### A concrete decoded example

If you paste a real token from this application into [jwt.io](https://jwt.io), you would see something like:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9
.
eyJzdWIiOiJhM2Y5ZTFiMi04NzY1LTQzMjEtYWJjZC1lZjAxMjM0NTY3ODkiLCJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwianRpIjoiYzlkNGU3ZjEtMDEyMy00NTY3LTg5YWItY2RlZjAxMjM0NTY3IiwiaWF0IjoxNzQ4NzAwMDAwLCJleHAiOjE3NDg3ODY0MDB9
.
<signature>
```

The payload decodes to exactly the JSON object shown above. The critical insight is that the payload is *encoded*, not *encrypted* — anyone with the token can read the claims by Base64URL-decoding the middle segment. **Never put sensitive data (credit card numbers, passwords, secrets) in a JWT payload.**

---

### 1.2 Authentication vs. Authorisation

These two words are frequently confused even by experienced engineers. They represent completely different questions:

| Question | Term | HTTP status on failure |
|----------|------|------------------------|
| "Who are you?" | **Authentication** | `401 Unauthorized` |
| "Are you allowed to do this?" | **Authorisation** | `403 Forbidden` |

**Analogy:** A hotel key card is authentication — it proves you are a registered guest. Whether that key opens the gym at 11pm (a premium-tier restriction) is authorisation.

In this codebase the boundary is explicit:

- The `authenticate` middleware answers: is this a real, unexpired, un-revoked token issued by this server? If no → 401.
- The `requireProjectRole` middleware answers: does this authenticated user have a high-enough role in this specific project? If no → 403.

These are always applied in that order on protected, project-scoped routes. Reversing the order would be nonsensical: you cannot check whether a user has a role in a project before you know who the user is.

---

### 1.3 Role-Based Access Control (RBAC)

#### What RBAC is

RBAC assigns permissions to *roles* rather than directly to *users*. A user is then given one or more roles. To check whether a user can perform an action, you check their role, not the user directly.

**Pseudocode of a naive ACL approach (flat per-user permissions):**

```
permissions = {
  "user:alice": ["project:123:read", "project:123:write", "project:123:delete"],
  "user:bob":   ["project:123:read"],
  ...
}
```

This becomes unmanageable at scale. Adding a new permission means updating every affected user record. Auditing who can do what requires scanning every user.

**RBAC approach:**

```
roles = {
  "ADMIN":        ["read", "write", "delete", "manage_members"],
  "PROJECT_LEAD": ["read", "write", "delete"],
  "MEMBER":       ["read", "write"],
  "VIEWER":       ["read"],
}

user_roles = {
  "alice": "ADMIN",
  "bob":   "VIEWER",
}
```

To add a new "export" permission for leads, you change one role definition, not hundreds of user records.

#### The role hierarchy in this codebase

The RBAC middleware in `src/core/middleware/rbac.ts` maps roles to numeric ranks:

```typescript
// src/core/middleware/rbac.ts, lines 8–13
const roleRank: Record<ProjectRole, number> = {
  [ProjectRole.ADMIN]:        4,
  [ProjectRole.PROJECT_LEAD]: 3,
  [ProjectRole.MEMBER]:       2,
  [ProjectRole.VIEWER]:       1,
};
```

A route protected with `requireProjectRole(ProjectRole.MEMBER)` allows users with rank 2, 3, or 4 but blocks viewers (rank 1). This is an *ordered* (hierarchical) RBAC: each higher role automatically inherits all capabilities of lower roles. If a future role needs non-hierarchical permissions (e.g., a "billing-only" role that can see invoices but not project boards), the numeric rank approach would need to be extended with an explicit permissions set.

---

### 1.4 Password Hashing with bcrypt

#### Why not encrypt passwords?

Encryption is reversible if you have the key. If an attacker steals your database *and* your application code (which likely contains or loads the encryption key), they can decrypt every password. Hashing is a one-way function: there is no key to steal.

#### Why not use SHA-256 or MD5?

These are cryptographic hash functions designed for *speed*. An attacker with a GPU can compute billions of SHA-256 hashes per second, letting them run a dictionary or brute-force attack offline. bcrypt is deliberately *slow*.

#### How bcrypt works

bcrypt is based on the Blowfish cipher and has two properties that make it suitable for passwords:

1. **Salt** — bcrypt generates a random 128-bit salt and incorporates it into the hash. This means two users with the same password produce different hashes, and pre-computed rainbow tables are useless.

2. **Cost factor (salt rounds)** — the algorithm runs an internal loop `2^rounds` times. With `rounds=12`, the loop runs 4,096 times. With `rounds=13`, it runs 8,192 times.

**The trade-off:**

| Rounds | Approximate time (modern server) | Implication |
|--------|----------------------------------|-------------|
| 8 | ~10ms | Fast for users, fast for attackers |
| 10 | ~100ms | Acceptable for most APIs |
| 12 | ~300ms | Good default: noticeable latency, but a billion-hash offline attack now takes years instead of hours |
| 14 | ~1,200ms | Login feels slow; may be appropriate for admin accounts |

If rounds are **too low** (e.g. 4–8), an attacker who steals the database can crack most passwords in hours on commodity hardware. If rounds are **too high** (e.g. 15+), your login endpoint becomes slow enough to be accidentally a denial-of-service vector — each request holds a thread/CPU for over a second.

This codebase sets `BCRYPT_ROUNDS = 12` (`src/modules/auth/AuthService.ts`, line 14), which is the widely-accepted industry standard for web applications as of the mid-2020s. Revisit upward as hardware improves.

---

### 1.5 Token Revocation and Redis Blacklisting

#### The stateless JWT problem

A JWT is self-contained: once issued, any server with the secret can validate it. This is what makes JWTs horizontally scalable — no shared session store is needed. But it creates a revocation problem:

> If a user logs out, changes their password, or has their account compromised, the token they hold is still cryptographically valid until its `exp` timestamp passes.

With a session-based system, you delete the session from the database and the user is immediately locked out. With a stateless JWT, you cannot "un-sign" a token that has already been issued.

#### The Redis blacklist solution

The solution is to maintain a *denylist* — a set of token identifiers that should be rejected even though they are cryptographically valid. You store the identifier (not the full token), and you only need to keep it until the token would have expired anyway.

**Pseudocode:**

```
# On logout:
redis.SETEX("revoked:<jti>", ttl_seconds, "1")

# On every authenticated request:
if redis.EXISTS("revoked:<jti>"):
    return 401 Token revoked
```

This trades a small Redis lookup on every request for the ability to immediately invalidate tokens. The key automatically expires from Redis at the same time the token would have expired — no cleanup job required.

This is not a perfect solution for every scenario. If Redis is unavailable, you must decide whether to fail-open (allow all requests — security risk) or fail-closed (reject all requests — availability risk). This codebase fails closed: `redis.exists()` will throw and the request will fail with an unhandled error, which defaults to a 500 response. In a production system you would add circuit-breaker logic around the Redis call.

#### Why the `jti` claim is essential

`jti` (JWT ID) is the anchor for revocation. Without it, the only thing you could blacklist is the entire token string, which is long (hundreds of bytes) and wasteful to store. With `jti`, each token has a compact, unique identifier (a UUID in this codebase) that you store in Redis.

The `jti` must be:
- **Globally unique** — if two tokens share a `jti`, revoking one revokes both. `randomUUID()` from Node's built-in `crypto` module produces a version 4 UUID with 122 bits of randomness, making collisions astronomically unlikely.
- **Unpredictable** — a sequential or guessable `jti` would allow an attacker to enumerate and check which tokens exist in the blacklist.

---

### 1.6 Rate Limiting

Rate limiting caps how many requests a client can make in a given time window. Without it:

- **Brute force attacks**: An attacker can try millions of password combinations against the login endpoint. Even with bcrypt slowing each individual check to 300ms, 10 concurrent connections could attempt ~200 guesses/minute.
- **Denial of Service**: A single misbehaving client (malicious or buggy) can consume all server resources, degrading the experience for legitimate users.
- **Credential stuffing**: Automated tools replay lists of stolen username/password pairs from other breaches against your API.

The rate limiter in this codebase uses a **Redis sorted-set sliding window**, which is more accurate than a fixed-window counter (which has a boundary-doubling flaw: a client can make MAX requests at 11:59:59 and MAX more at 12:00:00, doubling their effective rate).

**How the sliding window works:**

```
# On each request from IP x.x.x.x:
key = "rate_limit:x.x.x.x"
now = current_timestamp_ms
windowStart = now - 60_000  # 60-second window

# 1. Prune entries older than the window
ZREMRANGEBYSCORE key -inf windowStart

# 2. Count remaining entries (requests in this window)
count = ZCARD key

# 3. If over limit, return 429
if count >= MAX_REQUESTS: return 429

# 4. Record this request as a member with score = timestamp
ZADD key now "<now>-<random>"

# 5. Set TTL so the key auto-expires when the window passes
EXPIRE key 60
```

Each sorted-set member represents one request. The score is the request timestamp. `ZREMRANGEBYSCORE` removes old members efficiently — Redis sorted sets support O(log N + M) range deletions.

---

### 1.7 HTTP Status Codes: 401 vs. 403

| Code | Name | Meaning | When to use in this system |
|------|------|---------|---------------------------|
| `401` | Unauthorized | The request lacks valid authentication credentials | Missing `Authorization` header, malformed token, expired token, revoked token |
| `403` | Forbidden | The server understood the request but refuses to authorise it | Authenticated user lacks the required project role |

A common mistake is returning 401 for all access failures. This leaks information: if a user gets a 403, they know the resource exists but they are not allowed. Returning 404 instead is sometimes appropriate for sensitive resources (security through obscurity), but this codebase uses 403 correctly — the user already knows which project they are trying to access, so hiding its existence provides no benefit.

---

## Part 2 — Implementation Walkthrough

### 2.1 Request Validation with Joi

Before business logic runs, every incoming request is validated by Joi schemas defined in `src/modules/auth/schemas/authSchemas.ts`:

```typescript
// src/modules/auth/schemas/authSchemas.ts
import Joi from 'joi';

/** Schema for POST /auth/register */
export const registerSchema = Joi.object({
  email:       Joi.string().email().required(),
  displayName: Joi.string().min(2).max(100).required(),
  password:    Joi.string().min(8).required(),
});

/** Schema for POST /auth/login */
export const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().required(),
});
```

**What each rule enforces and why:**

- `Joi.string().email()` — validates the email format (presence of `@`, a domain, a TLD). Without this, a user could register with `alice` as their email, which would succeed at the database layer (it is just a string), but fail to receive verification emails and be impossible to look up correctly.
- `displayName.min(2).max(100)` — prevents both empty names and names long enough to cause database column overflow or UI rendering issues.
- `password.min(8)` — a baseline length requirement. Without this, users could register with a single-character password, which bcrypt would hash just fine — the vulnerability is that short passwords have a tiny search space for brute force.
- `password` in the login schema has no `min()` — by design. You do not want to reveal whether a password was rejected because it was too short or because it was wrong.

The `validate` middleware applies these schemas before the controller runs. If validation fails, a `400 Bad Request` is returned before the database is touched. This prevents both garbage data and unnecessary DB load.

---

### 2.2 The Register Flow

```
POST /api/v1/auth/register
  { email, displayName, password }
         │
         ▼
  [validate(registerSchema)]
  Joi validates all fields — rejects with 400 if invalid
         │
         ▼
  AuthController.register()
  Extracts body fields, delegates to AuthManager.register()
         │
         ▼
  AuthService.register(email, displayName, password)
         │
         ├── UserRepository.findByEmail(email)
         │     └── SELECT * FROM users WHERE email = ?
         │     If found → throw ConflictError → 409 response
         │
         ├── bcrypt.hash(password, 12)
         │     Generates random salt, runs 4096 rounds of Blowfish
         │     Returns: "$2a$12$<salt22chars><hash31chars>"
         │
         ├── UserRepository.save({ email, displayName, passwordHash })
         │     INSERT INTO users (id, email, display_name, password_hash, ...)
         │     id is generated as UUID by TypeORM
         │
         └── omit(user, ['passwordHash'])
               Returns user object WITHOUT passwordHash
               → 201 Created
```

**Key code — `AuthService.register`** (`src/modules/auth/AuthService.ts`, lines 24–31):

```typescript
async register(email: string, displayName: string, password: string): Promise<Omit<User, 'passwordHash'>> {
  const existing = await this.userRepo.findByEmail(email);
  if (existing) throw new ConflictError('Email already registered');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await this.userRepo.save({ email, displayName, passwordHash });
  return omit(user, ['passwordHash']);
}
```

**What goes wrong without each step:**

- Without the duplicate check: two users can register with the same email. The database `UNIQUE` constraint on `email` would still catch it (throwing a cryptic DB error), but handling it at the application layer gives a clean 409 response.
- Without `bcrypt.hash`: the plaintext password is stored in the database. A database dump, a SQL injection vulnerability, or a rogue DBA compromises every user's password and, by extension, every other site where they reused that password.
- Without `omit(user, ['passwordHash'])`: the API response includes the password hash. While a bcrypt hash cannot be reversed directly, returning it is a security smell: it gives an attacker the hash to run offline attacks against, and it violates the principle of least disclosure.

---

### 2.3 The Login Flow

```
POST /api/v1/auth/login
  { email, password }
         │
         ▼
  [validate(loginSchema)]
         │
         ▼
  AuthService.login(email, password)
         │
         ├── UserRepository.findByEmail(email)
         │     If NOT found → throw UnauthorizedError('Invalid credentials')
         │     NOTE: same message as wrong password — no user enumeration
         │
         ├── bcrypt.compare(password, user.passwordHash)
         │     Re-derives hash with the stored salt, compares
         │     If mismatch → throw UnauthorizedError('Invalid credentials')
         │
         ├── randomUUID()  ← generates the jti
         │
         ├── jwt.sign(
         │     { sub: user.id, email: user.email, jti },
         │     env.JWT_SECRET,
         │     { expiresIn: env.JWT_EXPIRES_IN }
         │   )
         │
         └── omit(user, ['passwordHash'])
               Returns { accessToken, user } → 200 OK
```

**Key code — `AuthService.login`** (`src/modules/auth/AuthService.ts`, lines 37–52):

```typescript
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
```

**Critical security details:**

- **Constant-time comparison**: `bcrypt.compare` is constant-time. A naive `hash(input) === stored` comparison using string equality would be vulnerable to timing attacks — an attacker could measure response time to determine how many characters of the hash matched.
- **User enumeration prevention**: both "user not found" and "wrong password" throw the same error message: `'Invalid credentials'`. If you returned `'User not found'` for a missing email, an attacker could enumerate which emails are registered in your system.
- **`jti` uniqueness**: `randomUUID()` (Node.js built-in `crypto` module) generates a v4 UUID per login. Each call to `login` produces a token with a unique `jti`, so two logins for the same user can be independently revoked.

---

### 2.4 The Logout Flow

```
POST /api/v1/auth/logout
  Authorization: Bearer <token>
         │
         ▼
  [authenticate middleware]  ← validates token, populates ctx.state.jti and ctx.state.exp
         │
         ▼
  AuthController.logout(ctx)
  Reads ctx.state.jti and ctx.state.exp
         │
         ▼
  AuthService.logout(jti, exp)
         │
         ├── ttl = exp - now_in_seconds   (minimum 1 second)
         │
         └── redis.setex("jwt:revoked:<jti>", ttl, "1")
               Key auto-expires when the token would have expired anyway
               → 204 No Content
```

**Key code — `AuthService.logout`** (`src/modules/auth/AuthService.ts`, lines 59–62):

```typescript
async logout(jti: string, exp: number): Promise<void> {
  const ttl = Math.max(exp - Math.floor(Date.now() / 1000), 1);
  await redis.setex(CacheKeys.jwtRevoked(jti), ttl, '1');
}
```

The TTL calculation is precise: if the token expires in 3,600 seconds, the Redis key also lives exactly 3,600 seconds. After that, both the token and its blacklist entry are gone — no Redis bloat over time.

The minimum of `1` handles the edge case where `exp` is in the past (an already-expired token). You still want to write to Redis in case the same `jti` appears in a replay attack (though `jwt.verify` would reject an expired token before `authenticate` ever checks Redis).

---

### 2.5 The `authenticate` Middleware in Detail

Every protected route passes through `src/core/middleware/auth.ts`. Here is the full middleware with a step-by-step breakdown:

```typescript
// src/core/middleware/auth.ts
export const authenticate: Middleware = async (ctx, next) => {
  // Step 1: Extract the Bearer token
  const authHeader = ctx.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('Missing Bearer token');

  const token = authHeader.slice(7);   // strips "Bearer "

  // Step 2: Cryptographically verify the token
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }

  // Step 3: Check the Redis revocation list
  const revoked = await redis.exists(CacheKeys.jwtRevoked(payload.jti));
  if (revoked) throw new UnauthorizedError('Token has been revoked');

  // Step 4: Attach user identity to request context
  ctx.state.user = { id: payload.sub, email: payload.email };
  (ctx.state as any).jti = payload.jti;
  (ctx.state as any).exp = payload.exp;

  await next();
};
```

**Step-by-step:**

1. **Header extraction**: `authHeader.slice(7)` drops the `"Bearer "` prefix (7 characters). The `?.startsWith('Bearer ')` check ensures the header is present and correctly formatted before slicing.

2. **`jwt.verify`**: This call does several things simultaneously — it Base64URL-decodes the header and payload, re-derives the HMAC signature from the secret, compares it to the signature in the token, and checks that `exp > now`. Any failure throws, and all failures are surfaced as the same `'Invalid or expired token'` message to avoid leaking which specific check failed.

3. **Redis revocation check**: `CacheKeys.jwtRevoked(payload.jti)` generates the key `jwt:revoked:<jti>`. `redis.exists()` returns `1` if the key exists, `0` if not. This is an O(1) Redis operation.

4. **`ctx.state` population**: Koa's `ctx.state` is the conventional location for per-request data shared between middleware. Downstream middleware (`requireProjectRole`) and controllers read `ctx.state.user.id`. The `jti` and `exp` are stored here so the logout controller can access them without re-parsing the token.

**What happens if you skip the Redis check?**

A logged-out token remains valid for its entire lifetime. An attacker who intercepts a token (via a network log, XSS, or compromised browser storage) can use it even after the user has explicitly logged out. The Redis check is the only mechanism that bridges the gap between token issuance and natural expiry.

---

### 2.6 The RBAC Middleware in Detail

After `authenticate` confirms identity, `requireProjectRole` enforces project-level authorisation. It is a middleware *factory* — it returns a new middleware function configured with the required minimum role:

```typescript
// src/core/middleware/rbac.ts
export const requireProjectRole = (minRole: ProjectRole): Middleware =>
  async (ctx, next) => {
    const { projectId } = ctx.params;       // from the route URL, e.g. /projects/:projectId/issues
    const userId = ctx.state.user.id;       // set by authenticate

    // Step 1: Try the cache first
    let role = await membershipCache.get(projectId, userId);

    // Step 2: Cache miss — query the database
    if (!role) {
      const repo = AppDataSource.getRepository(ProjectMember);
      const membership = await repo.findOne({ where: { projectId, userId } });

      if (!membership) throw new ForbiddenError('access', 'this project');

      role = membership.role;
      membershipCache.set(projectId, userId, role).catch(() => {});   // fire-and-forget, don't delay response
    }

    // Step 3: Check the role hierarchy
    if (roleRank[role] < roleRank[minRole]) {
      throw new ForbiddenError(`perform this action (requires ${minRole})`, 'this project');
    }

    // Step 4: Expose the resolved role downstream
    ctx.state.projectRole = role;
    await next();
  };
```

**The cache-then-DB pattern explained:**

Checking project membership for every request against the database would add a DB round-trip to every project-scoped endpoint. With `MembershipCache`, the first request after a membership change hits the DB and populates the cache. Subsequent requests within the 5-minute TTL window are served from Redis (microseconds vs. milliseconds).

**`fire-and-forget` cache population**: Note `membershipCache.set(...).catch(() => {})`. The `.catch` prevents an unhandled promise rejection if Redis is temporarily unavailable. The failure is silently swallowed — the request still succeeds because we already have the role from the DB. On the next request, the cache miss will trigger another DB query. This is a deliberate availability-over-consistency trade-off.

**Role hierarchy enforcement**: `roleRank[role] < roleRank[minRole]` is a single numeric comparison. A viewer (rank 1) trying to access a member-only (rank 2) route fails here. An admin (rank 4) trying to access any route passes, because 4 >= any defined rank.

**Usage on a route:**

```typescript
router.delete(
  '/projects/:projectId/members/:memberId',
  authenticate,
  requireProjectRole(ProjectRole.ADMIN),
  ProjectController.removeMember
);
```

The `authenticate` middleware runs first (identity), then `requireProjectRole` (authorisation). If either fails, the next middleware — the controller — never runs.

---

### 2.7 MembershipCache: Caching Strategy for RBAC

```typescript
// src/infrastructure/cache/MembershipCache.ts
export class MembershipCache {
  async get(projectId: string, userId: string): Promise<ProjectRole | null> {
    const val = await redis.get(CacheKeys.membershipRole(projectId, userId));
    return (val as ProjectRole) ?? null;
  }

  async set(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await redis.setex(
      CacheKeys.membershipRole(projectId, userId),
      CACHE_TTL.MEMBERSHIP_SECONDS,
      role,
    );
  }

  async del(projectId: string, userId: string): Promise<void> {
    await redis.del(CacheKeys.membershipRole(projectId, userId));
  }
}

export const membershipCache = new MembershipCache();
```

The `del` method is called by `ProjectService` whenever membership changes: `addMember`, `removeMember`, and `updateMemberRole` all call `membershipCache.del(projectId, userId)`. This is explicit *cache invalidation on write*. Without it, a demoted user would continue to have elevated privileges for up to `MEMBERSHIP_SECONDS` after the change.

The cache stores the role value as a string (the `ProjectRole` enum value, e.g. `"MEMBER"`). On retrieval, it is cast back to `ProjectRole`. This is safe because the only values ever written are the enum values themselves.

---

### 2.8 CacheKeys: Centralised Key Management

```typescript
// src/infrastructure/cache/CacheKeys.ts
export const CacheKeys = {
  /** RBAC role for a user within a project: membership:{projectId}:{userId} */
  membershipRole: (projectId: string, userId: string) =>
    `membership:${projectId}:${userId}`,

  /** JWT blacklist entry: jwt:revoked:{jti} */
  jwtRevoked: (jti: string) => `jwt:revoked:${jti}`,

  // ... other keys
} as const;
```

**Why centralise cache key strings?**

Without a central registry, key patterns are scattered across the codebase as magic strings. Problems that arise:

- **Typos**: `"jwt:revokd:"` vs. `"jwt:revoked:"` — the logout writes to one key, the authenticate middleware reads from another. Revocation silently stops working.
- **Pattern inconsistency**: one file uses `membership:{projectId}:{userId}`, another uses `member-role:{userId}:{projectId}` (different order, different separator). Invalidation misses.
- **Namespace collisions**: without namespacing, a key named `"sprint:123"` for sprint data could collide with an unrelated module also using `"sprint:123"`.

By routing all key construction through `CacheKeys`, TypeScript provides: autocompletion (you never have to remember the format), type safety (missing parameters are compile-time errors), and a single source of truth to update if a key schema changes.

---

### 2.9 The Rate Limiter in Detail

```typescript
// src/core/middleware/rateLimiter.ts
export const rateLimiter = async (ctx: Context, next: Next): Promise<void> => {
  const ip  = ctx.ip || 'unknown';
  const key = `rate_limit:${ip}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_CONSTANTS.WINDOW_SECONDS * 1000;   // 60 seconds ago

  await redis.zremrangebyscore(key, '-inf', windowStart);   // prune old entries
  const count = await redis.zcard(key);                     // count current window

  if (count >= RATE_LIMIT_CONSTANTS.MAX_REQUESTS) {
    ctx.status = 429;
    ctx.body   = { error: 'Too many requests. Please try again later.' };
    ctx.set('Retry-After', String(RATE_LIMIT_CONSTANTS.WINDOW_SECONDS));
    return;
  }

  await redis.zadd(key, now, `${now}-${Math.random()}`);    // record this request
  await redis.expire(key, RATE_LIMIT_CONSTANTS.WINDOW_SECONDS);

  ctx.set('X-RateLimit-Limit',     String(RATE_LIMIT_CONSTANTS.MAX_REQUESTS));
  ctx.set('X-RateLimit-Remaining', String(RATE_LIMIT_CONSTANTS.MAX_REQUESTS - count - 1));

  await next();
};
```

**Headers returned to the client:**

- `X-RateLimit-Limit`: the maximum number of requests allowed in the window (100 by default)
- `X-RateLimit-Remaining`: how many requests the client has left in the current window
- `Retry-After` (on 429 only): seconds until the window resets — tells the client when to retry

**The member value `${now}-${Math.random()}`**: Each sorted-set member must be unique. Since multiple requests could arrive in the same millisecond, appending a random suffix prevents member collisions, which would cause `ZADD` to update an existing entry rather than add a new one, under-counting the request rate.

**Configuring the limit:** The constant reads from `process.env['RATE_LIMIT_MAX']`, defaulting to 100. This allows per-environment configuration: production might allow 100 requests/minute, a test environment might set it to 10,000 to avoid test failures.

---

### 2.10 The Route Registration

```typescript
// src/modules/auth/routes/v1/authRoutes.ts
export const authRouter = new Router({ prefix: '/auth' });

authRouter.post('/register', validate(registerSchema), AuthController.register);
authRouter.post('/login',    validate(loginSchema),    AuthController.login);
authRouter.post('/logout',   authenticate,             AuthController.logout);
```

Notice: `/register` and `/login` do **not** have the `authenticate` middleware. They are intentionally public — they are how a user obtains a token in the first place. `/logout` requires `authenticate` because you need a valid token to know *which* token to revoke. Calling logout without a token would have no `jti` to blacklist.

---

### 2.11 The User Model

```typescript
// src/models/User.ts
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ unique: true, length: 255 })
  email!: string;

  @Column({ name: 'display_name', length: 100 })
  displayName!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  readonly updatedAt!: Date;
}
```

The `passwordHash` column stores the bcrypt output, which is always 60 characters in the `$2a$12$...` format. TypeORM's `@Column({ name: 'password_hash' })` maps the camelCase TypeScript property to the snake_case database column name — a convention used throughout this codebase.

The `unique: true` on `email` creates a database-level unique constraint. Even if the application-level duplicate check in `AuthService.register` is bypassed (e.g. due to a race condition with two simultaneous requests), the database will reject the second insert.

---

### 2.12 Full Authentication Flow Diagram

```
CLIENT                      KOA APP                      REDIS             DATABASE
  │                            │                            │                  │
  │  POST /auth/register       │                            │                  │
  │  {email, displayName, pw}  │                            │                  │
  │ ──────────────────────────►│                            │                  │
  │                            │ validate(registerSchema)   │                  │
  │                            │ ──[Joi]──────────────────► X (local, no I/O) │
  │                            │                            │                  │
  │                            │ findByEmail(email)         │                  │
  │                            │ ────────────────────────────────────────────►│
  │                            │◄────────────────────────────────────────────-│
  │                            │ (null — not found)         │                  │
  │                            │                            │                  │
  │                            │ bcrypt.hash(pw, 12)        │                  │
  │                            │ ──[CPU]───────────────────►X (local, ~300ms) │
  │                            │                            │                  │
  │                            │ repo.save(user)            │                  │
  │                            │ ────────────────────────────────────────────►│
  │                            │◄────────────────────────────────────────────-│
  │                            │ (saved user with id)       │                  │
  │                            │                            │                  │
  │◄──────────────────────────-│                            │                  │
  │  201 {id, email, ...}      │                            │                  │
  │  (no passwordHash!)        │                            │                  │
  │                            │                            │                  │
  │  POST /auth/login          │                            │                  │
  │  {email, password}         │                            │                  │
  │ ──────────────────────────►│                            │                  │
  │                            │ findByEmail(email)         │                  │
  │                            │ ────────────────────────────────────────────►│
  │                            │◄────────────────────────────────────────────-│
  │                            │ bcrypt.compare(pw, hash)   │                  │
  │                            │ ──[CPU]───────────────────►X (~300ms)        │
  │                            │ randomUUID() → jti         │                  │
  │                            │ jwt.sign(...)              │                  │
  │◄──────────────────────────-│                            │                  │
  │  200 {accessToken, user}   │                            │                  │
  │                            │                            │                  │
  │  GET /api/v1/projects      │                            │                  │
  │  Authorization: Bearer ... │                            │                  │
  │ ──────────────────────────►│                            │                  │
  │                            │ [authenticate]             │                  │
  │                            │ jwt.verify(token, secret)  │                  │
  │                            │ redis.exists(jwt:revoked:jti)                 │
  │                            │ ────────────────────────────────────────────►│
  │                            │◄────────────────────────────────────────────-│
  │                            │ (0 — not revoked)          │                  │
  │                            │ ctx.state.user = {id, email}                 │
  │                            │ [requireProjectRole]       │                  │
  │                            │ membershipCache.get(...)   │                  │
  │                            │ ─────────────────────────►│                  │
  │                            │◄─────────────────────────-│                  │
  │                            │ (role or null)             │                  │
  │◄──────────────────────────-│                            │                  │
  │  200 { data: [...] }       │                            │                  │
  │                            │                            │                  │
  │  POST /auth/logout         │                            │                  │
  │  Authorization: Bearer ... │                            │                  │
  │ ──────────────────────────►│                            │                  │
  │                            │ [authenticate] (same as above)                │
  │                            │ AuthService.logout(jti, exp)                 │
  │                            │ redis.setex(jwt:revoked:jti, ttl, "1")       │
  │                            │ ─────────────────────────►│                  │
  │◄──────────────────────────-│                            │                  │
  │  204 No Content            │                            │                  │
```

---

## Key Takeaways

- **JWTs are tamper-evident, not secret.** The payload is Base64URL-encoded and readable by anyone. Never store sensitive data in JWT claims. The signature only proves the server issued the token — it does not encrypt the contents.

- **Authentication (401) and authorisation (403) are distinct operations** that must run in sequence. Confirming identity comes first; checking permissions against that identity comes second. Conflating them produces both wrong HTTP semantics and security gaps.

- **bcrypt's cost factor is a deliberate performance trade-off.** `BCRYPT_ROUNDS = 12` means every login takes ~300ms of CPU. This is intentional: it makes offline brute-force attacks against a stolen hash database impractical. Treat it as a tunable security dial, not an implementation detail to optimise away.

- **Stateless JWTs require a sidecar store for revocation.** The Redis blacklist (keyed by `jti`, TTL-matched to token expiry) is not a workaround — it is the standard solution to the stateless revocation problem. The `jti` must be globally unique and unpredictable; `randomUUID()` satisfies both requirements.

- **Cache invalidation on write is mandatory for RBAC correctness.** `MembershipCache.del()` must be called whenever a membership changes. Without explicit invalidation, a demoted or removed user continues to pass RBAC checks for the duration of the cache TTL — a privilege escalation vulnerability.

- **Centralised cache key builders (`CacheKeys`) eliminate an entire class of runtime bugs.** Scattered magic strings in Redis lookups are a silent failure mode: a typo in one place means a write and a read never see the same key, and no error is thrown.

- **Rate limiting belongs at the edge, applied before authentication.** An unauthenticated brute-force attack against `/auth/login` must be stopped before it reaches bcrypt. The Redis sorted-set sliding window is accurate across restarts and across horizontally scaled instances because the state lives in Redis, not in application memory.

- **User enumeration is a real threat.** Returning different error messages for "user not found" versus "wrong password" leaks your user database to an attacker doing account discovery. Both cases must return the same message and take the same approximate time (constant-time compare handles the latter).

---

## Further Reading

- **RFC 7519** — "JSON Web Token (JWT)" — the IETF standard defining the JWT structure, registered claim names, and serialisation rules. Available at https://datatracker.ietf.org/doc/html/rfc7519

- **"The Web Application Hacker's Handbook"** by Stuttard & Pinto (Wiley, 2011) — covers authentication bypass, session management attacks, and access control vulnerabilities with practical exploitation examples that motivate each defensive pattern used in this codebase.

- **OWASP Authentication Cheat Sheet** — a maintained, practical reference on credential storage, brute-force protection, session management, and MFA. Available at https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

- **"Hacking: The Art of Exploitation"** by Jon Erickson (No Starch Press, 2008) — provides the low-level understanding of why hash functions and cryptographic primitives behave the way they do, essential context for understanding what bcrypt is protecting against.

- **NIST Special Publication 800-63B** — "Digital Identity Guidelines: Authentication and Lifecycle Management" — the US federal standard for password policies, hashing requirements, and memorised-secret authenticators. Directly informs choices like minimum password length and cost factors. Available at https://pages.nist.gov/800-63-3/sp800-63b.html
