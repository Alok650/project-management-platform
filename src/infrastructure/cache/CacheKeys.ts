/** Typed Redis key builders — keeps key patterns in one place */
export const CacheKeys = {
  /** Board state JSON cache per sprint: board:{projectId}:sprint:{sprintId|backlog} */
  boardState: (projectId: string, sprintId: string | null) =>
    `board:${projectId}:sprint:${sprintId ?? 'backlog'}`,

  /** Glob pattern to invalidate all sprint board caches for a project */
  boardStatePattern: (projectId: string) => `board:${projectId}:sprint:*`,

  /** RBAC role for a user within a project: membership:{projectId}:{userId} */
  membershipRole: (projectId: string, userId: string) =>
    `membership:${projectId}:${userId}`,

  /** Individual issue entity (full object): issue:{issueId} */
  issueEntity: (issueId: string) => `issue:${issueId}`,

  /** Sprint-keyed sorted-set index of issue IDs: idx:sprint:{projectId}:{sprintId|backlog} */
  sprintIssueIndex: (projectId: string, sprintId: string | null) =>
    `idx:sprint:${projectId}:${sprintId ?? 'backlog'}`,

  /** Status-keyed sorted-set index of issue IDs: idx:status:{projectId}:{statusId} */
  statusIssueIndex: (projectId: string, statusId: string) =>
    `idx:status:${projectId}:${statusId}`,

  /** Cached sprint list for a project: sprints:{projectId} */
  sprintList: (projectId: string) => `sprints:${projectId}`,

  /** Cached project list for a user: projects:user:{userId} */
  projectList: (userId: string) => `projects:user:${userId}`,

  /** JWT blacklist entry: jwt:revoked:{jti} */
  jwtRevoked: (jti: string) => `jwt:revoked:${jti}`,

  /** Circuit-breaker state: cb:{name} */
  circuitBreaker: (name: string) => `cb:${name}`,

  /** Sliding-window rate limit sorted-set: ratelimit:{userId}:{endpoint} */
  rateLimit: (userId: string, endpoint: string) => `ratelimit:${userId}:${endpoint}`,

  /** WS event replay sorted-set: events:{projectId} */
  events: (projectId: string) => `events:${projectId}`,

  /** Presence hash: presence:{projectId} */
  presence: (projectId: string) => `presence:${projectId}`,

  /** User session: session:{userId} */
  session: (userId: string) => `session:${userId}`,
} as const;
