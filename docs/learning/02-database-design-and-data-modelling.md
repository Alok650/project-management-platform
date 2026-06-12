# Database Design & Data Modelling

## What You'll Learn

- What data modelling is and why a poorly designed schema is expensive to fix later
- The three normal forms and how this codebase achieves 3NF — with one deliberate, documented exception
- How B-tree, composite, and full-text indexes work, and which query patterns each one serves
- The difference between optimistic and pessimistic locking, and how `@VersionColumn` implements optimistic locking on the `issues` table
- Why database migrations exist, how the six migration files in this project are ordered, and what would break if you applied them out of sequence
- What foreign key constraints and cascade rules do, and what silent data corruption looks like without them
- Why this project uses UUIDs as primary keys instead of auto-incrementing integers, and what that costs
- The junction table pattern illustrated by `project_members` and `issue_watchers`
- How the `issue_key_counters` table produces race-safe, project-scoped keys like `PROJ-42` atomically

---

## Part 1 — Theory

### 1.1 What Is Data Modelling, and Why Does It Matter?

Data modelling is the process of deciding how your application's concepts — users, projects, issues, comments — map onto tables, columns, and relationships in a relational database. It is a design activity that happens before you write a single line of application code, and its effects last for the lifetime of the system.

A bad data model is expensive. Once thousands of rows exist in production, fixing a structural mistake requires a live migration: locking tables, moving data, rewriting queries, coordinating downtime. Getting the model right up front means your queries are fast, your data is consistent, and adding new features requires adding new tables rather than reforming existing ones.

A good data model has three properties:

1. **Integrity** — the database enforces its own rules. You cannot insert an issue that references a non-existent project. You cannot assign a user to a project twice.
2. **Minimal redundancy** — the same fact is stored in exactly one place. If a user's email changes, you update one row, not twenty.
3. **Query alignment** — the table structure matches the queries that will run against it. The right indexes exist for the right access patterns.

---

### 1.2 Normalisation: 1NF, 2NF, and 3NF

Normalisation is a formal process for eliminating data redundancy. Each "normal form" (NF) adds an additional constraint.

**First Normal Form (1NF):** Every column must contain atomic (indivisible) values. No repeating groups, no comma-separated lists inside a single column.

Imagine a naive table:

```sql
-- Violates 1NF: multiple values crammed into one column
CREATE TABLE projects_bad (
  id   INT PRIMARY KEY,
  name VARCHAR(200),
  member_ids VARCHAR(500)  -- "uuid1,uuid2,uuid3" — wrong
);
```

To fetch a specific member you need `LIKE '%uuid2%'`, which cannot use an index. The fix is a separate `project_members` table — exactly what this codebase does.

**Second Normal Form (2NF):** Requires 1NF, plus every non-key column must depend on the *entire* primary key — not just part of it. This only matters when the primary key is composite.

Imagine a `project_members` table where the PK is `(project_id, user_id)`:

```sql
-- Violates 2NF if the PK were composite (project_id, user_id)
-- because project_name depends only on project_id, not the full key
CREATE TABLE project_members_bad (
  project_id   VARCHAR(36),
  user_id      VARCHAR(36),
  project_name VARCHAR(200),  -- partial dependency — wrong
  role         ENUM('ADMIN','MEMBER'),
  PRIMARY KEY (project_id, user_id)
);
```

In this schema, `project_name` changes in one place (`projects.name`) but would be stale in every `project_members_bad` row. The fix: store the name only in `projects` and join when needed. This codebase avoids this problem entirely by using surrogate UUID primary keys on every join table — `ProjectMember.id` is a UUID, and `role` is the only non-key attribute, which naturally depends on both the project and the user.

**Third Normal Form (3NF):** Requires 2NF, plus no non-key column may depend on another non-key column (no transitive dependencies).

```sql
-- Violates 3NF: zip_code → city creates a transitive dependency
CREATE TABLE users_bad (
  id       INT PRIMARY KEY,
  name     VARCHAR(100),
  zip_code CHAR(5),
  city     VARCHAR(100)  -- depends on zip_code, not id — wrong
);
```

If two users share the same zip code and the city name changes, you have to update multiple rows. The fix is a separate `cities` table.

**Where this codebase stands:** The schema is 3NF throughout, with one intentional, documented exception: `issues.labels` and `comments.mentions` are JSON columns rather than normalised tag tables. The migration comment for migration 1781070144603 explains: "labels are display-only and never queried with a JOIN." When you know a column will never be a JOIN predicate or a WHERE filter, denormalising to JSON is a reasonable engineering trade-off. The comment acknowledges this explicitly — it is not an oversight, it is a deliberate choice.

---

### 1.3 Database Indexes: B-Tree, Composite, and Full-Text

An index is a separate data structure the database maintains in parallel with your table. Reads become faster because the database can jump straight to matching rows instead of scanning every row from disk. Writes become slightly slower because the index must be updated alongside the table.

**B-Tree indexes** (the default for InnoDB) organise values in a sorted tree. Looking up `WHERE email = 'alice@example.com'` on a B-tree takes O(log n) time. Without an index, the database reads every row — O(n).

```sql
-- A lookup that uses the B-tree on users.email
SELECT id FROM users WHERE email = 'alice@example.com';
-- Execution plan: range scan on UQ_users_email — reads ~1 leaf page
```

**Composite indexes** cover multiple columns in a specific order. The order matters: a composite index on `(project_id, status_id)` can answer:
- `WHERE project_id = ?` — leftmost prefix, works
- `WHERE project_id = ? AND status_id = ?` — full key, works
- `WHERE status_id = ?` alone — cannot use this index, must full-scan

The Issue entity declares three composite indexes that directly match the application's access patterns:

```typescript
// src/models/Issue.ts, lines 14–16
@Index('idx_issues_project_status',  ['projectId', 'statusId'])
@Index('idx_issues_project_sprint',  ['projectId', 'sprintId'])
@Index('idx_issues_project_created', ['projectId', 'createdAt'])
```

The board view query is `WHERE project_id = ? AND status_id = ?` — served by `idx_issues_project_status`. The sprint backlog is `WHERE project_id = ? AND sprint_id = ?` — served by `idx_issues_project_sprint`. The paginated issue list is `WHERE project_id = ? ORDER BY created_at` — served by `idx_issues_project_created`.

**Full-text indexes** are fundamentally different from B-tree indexes. Rather than a sorted tree of column values, a full-text index builds an inverted index: a mapping from every distinct word to the set of rows containing that word. This enables relevance-ranked keyword search.

```sql
-- B-tree index: exact or prefix match only
SELECT * FROM issues WHERE title LIKE '%payment bug%';
-- Full table scan — LIKE with a leading wildcard cannot use B-tree

-- Full-text index: relevance-ranked token search
SELECT *, MATCH(title, description) AGAINST('payment bug' IN NATURAL LANGUAGE MODE) AS score
FROM issues
WHERE MATCH(title, description) AGAINST('payment bug' IN NATURAL LANGUAGE MODE)
ORDER BY score DESC;
-- Uses ft_issues_title_desc — scans only matching document IDs
```

Migration 1781070144605 adds both full-text indexes as a separate migration step because TypeORM's schema generator cannot produce `FULLTEXT` DDL — they must be written manually.

---

### 1.4 Optimistic Locking vs Pessimistic Locking

Both patterns solve the **lost update problem**: two users read the same row, both modify it independently, and the second writer silently overwrites the first writer's changes.

**Pessimistic locking** prevents the problem by acquiring an exclusive database lock before reading the row. No other transaction can read or write that row until the lock is released.

```sql
-- Pessimistic: locks the row for the duration of the transaction
BEGIN;
SELECT * FROM issues WHERE id = 'abc' FOR UPDATE;
-- No other session can touch this row until COMMIT/ROLLBACK
UPDATE issues SET title = 'New title', version = version + 1 WHERE id = 'abc';
COMMIT;
```

This is safe but reduces throughput. Every user who tries to view the same issue blocks. In a web application where users might leave a tab open for minutes, holding a database lock the entire time is impractical.

**Optimistic locking** assumes conflicts are rare. It does not lock anything. Instead, it adds a `version` column (an integer counter). The read returns the current version. The write checks that the version has not changed since the read. If it has, someone else updated the row — the write is rejected with a conflict error (HTTP 409).

```sql
-- Read
SELECT id, title, version FROM issues WHERE id = 'abc';
-- Returns: { id: 'abc', title: 'Old title', version: 3 }

-- Later: User A writes (succeeds because version still matches)
UPDATE issues
SET title = 'User A title', version = version + 1
WHERE id = 'abc' AND version = 3;
-- Affected rows: 1 — success

-- Even later: User B tries to write their stale read (version 3)
UPDATE issues
SET title = 'User B title', version = version + 1
WHERE id = 'abc' AND version = 3;
-- Affected rows: 0 — conflict! The version is now 4.
```

TypeORM implements this automatically with `@VersionColumn`. The entity field is simply declared:

```typescript
// src/models/Issue.ts, line 63–65
/** Incremented automatically by TypeORM on every save — used for optimistic locking */
@VersionColumn()
version!: number;
```

When `repository.save(issue)` is called, TypeORM automatically adds `AND version = :currentVersion` to the `WHERE` clause and increments `version` in the `SET` clause. If zero rows are affected, TypeORM throws an `OptimisticLockVersionMismatchError`, which the service layer catches and converts to a 409 response.

**Choose optimistic locking when:** conflicts are infrequent, read-to-write latency is long (users filling out a form), and you want maximum read throughput.

**Choose pessimistic locking when:** conflicts are frequent, the critical section is very short, and you cannot afford to retry (financial transactions, inventory decrement).

---

### 1.5 Database Migrations: Why You Never Alter Tables Manually

A migration is a versioned, reversible script that describes a single schema change. Instead of running `ALTER TABLE` directly in a production MySQL console, you write a migration file, commit it to version control, and run it via the migration CLI. Every environment — local, CI, staging, production — runs the same sequence of scripts.

Without migrations:

- There is no record of what changed or why
- You cannot reproduce the production schema on a new developer machine
- You cannot roll back a bad change safely
- CI cannot create a test database that matches production

With migrations:

- Every schema change is reviewed in a pull request alongside the application code that depends on it
- `typeorm migration:run` applies missing migrations in timestamp order
- `typeorm migration:revert` applies the `down()` method of the last migration, restoring the previous state
- The `migrations` table in the database records which migrations have been applied, preventing double-application

The migration timestamp acts as both a version number and an ordering key. Migration `1781070144603` runs after `1781070144602` because the integer is larger. This is why migration 603 can safely reference `workflow_statuses` and `projects` with foreign keys — those tables were created in migrations 601 and 602.

---

### 1.6 Foreign Key Constraints and Cascades

A foreign key constraint tells the database: "the value in column X must match a value in the primary key of table Y." The database enforces this on every insert and update.

Without foreign keys, application bugs silently create orphaned data:

```sql
-- Without FK constraint, this succeeds and creates a ghost issue
INSERT INTO issues (id, project_id, ...) VALUES ('x', 'non-existent-project-uuid', ...);

-- Months later, a query joins to projects and finds no matching row
SELECT i.*, p.name FROM issues i LEFT JOIN projects p ON i.project_id = p.id;
-- p.name is NULL — the project is gone, but the issue still references it
```

With the constraint in place, the INSERT raises an error immediately: `Cannot add or update a child row: a foreign key constraint fails`.

**Cascade rules** define what happens to child rows when a parent is deleted or updated:

- `ON DELETE CASCADE` — delete child rows automatically when the parent is deleted
- `ON DELETE SET NULL` — set the FK column to NULL when the parent is deleted
- `ON DELETE RESTRICT` (the default) — refuse to delete the parent if children exist

This schema uses `ON DELETE RESTRICT` everywhere (the InnoDB default) rather than cascade deletes. Projects are soft-deleted via `deleted_at` instead of being physically removed, so orphan protection through cascades is not needed — the parent row always exists.

---

### 1.7 UUIDs vs Auto-Increment IDs

**Auto-increment integers** (`INT AUTO_INCREMENT`) are sequential, compact, and fast to index. The disadvantages: they reveal information (an attacker can infer record counts from IDs), and they cannot be generated client-side before the INSERT.

**UUIDs** (`varchar(36)`, generated as `uuid()`) can be generated anywhere — in the application, in a queue worker, in a test — before the row exists in the database. This is critical for event-driven architectures and distributed systems where you need to reference an entity's ID before it has been persisted. The disadvantages: they are 36 bytes versus 4–8 bytes, UUID v4 values are random, which causes B-tree index fragmentation (rows are inserted at random positions in the index, not at the end).

This project uses UUIDs for every primary key:

```typescript
// src/models/User.ts, line 10–11
@PrimaryGeneratedColumn('uuid')
readonly id!: string;
```

The corresponding DDL (migration 601):

```sql
`id` varchar(36) NOT NULL,
-- ...
PRIMARY KEY (`id`)
```

The trade-off is accepted because:
1. IDs must not leak enumeration information (user IDs, issue IDs appear in URLs)
2. The application generates IDs in service layer code before writing to the database
3. The database is MySQL on a single primary — UUID index fragmentation is manageable at this scale

---

### 1.8 The Junction Table Pattern

A many-to-many relationship cannot be expressed with a single foreign key. A user can belong to many projects; a project can have many users. The standard solution is a junction table (also called an associative entity or bridge table) that holds one row per pair.

```
users ──< project_members >── projects
             │
           role (ADMIN / MEMBER / ...)
```

A plain junction table would have a composite primary key of `(project_id, user_id)`. This schema adds a surrogate UUID primary key (`id`) and stores the `role` attribute on the junction row itself. This is the correct pattern when the relationship carries its own data. The composite `UNIQUE` constraint (`@Unique(['projectId', 'userId'])`) still prevents duplicates at the database level:

```typescript
// src/models/ProjectMember.ts, lines 11–12
@Entity('project_members')
@Unique(['projectId', 'userId'])
export class ProjectMember {
```

The same pattern appears in `IssueWatcher` (lines 10–11 of `IssueWatcher.ts`): a user can watch many issues, an issue can be watched by many users, and the junction row records when the watch started (`createdAt`).

---

## Part 2 — Implementation Walkthrough

### 2.1 Full Entity-Relationship Diagram

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         ENTITY RELATIONSHIP DIAGRAM                              │
└──────────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────┐        ┌──────────────────┐        ┌──────────────┐
  │   users     │──1:N──▶│ project_members  │◀──N:1──│   projects   │
  │─────────────│        │──────────────────│        │──────────────│
  │ id (PK)     │        │ id (PK)          │        │ id (PK)      │
  │ email       │        │ project_id (FK)  │        │ name         │
  │ display_name│        │ user_id (FK)     │        │ key (UNIQ)   │
  │ password_hash        │ role (ENUM)      │        │ description  │
  │ created_at  │        │ joined_at        │        │ created_by   │◀──FK── users
  │ updated_at  │        └──────────────────┘        │ created_at   │
  └─────────────┘                                    │ updated_at   │
        │                                            │ deleted_at   │
        │ 1:N (memberships)                          └──────────────┘
        │                                                   │ 1:N
        │                                                   ▼
        │                                     ┌─────────────────────────┐
        │                                     │   workflow_statuses     │
        │                                     │─────────────────────────│
        │                                     │ id (PK)                 │
        │                                     │ project_id (FK)         │
        │                                     │ name                    │
        │                                     │ category (ENUM)         │
        │                                     │ position                │
        │                                     │ wip_limit               │
        │                                     │ created_at              │
        │                                     └─────────────────────────┘
        │                                            │  │  1:N
        │                                            │  └──────────────────────────┐
        │                                            │                             ▼
        │                                 ┌──────────┴──────────────┐  ┌──────────────────────────┐
        │                                 │  workflow_transitions   │  │  workflow_auto_actions   │
        │                                 │─────────────────────────│  │──────────────────────────│
        │                                 │ id (PK)                 │  │ id (PK)                  │
        │                                 │ project_id (FK)         │  │ transition_id (FK)       │
        │                                 │ from_status_id (FK)─────┘  │ type (ENUM)              │
        │                                 │ to_status_id (FK)──────────│ config (JSON)            │
        │                                 │ name                    │  │ created_at               │
        │                                 │ created_at              │  └──────────────────────────┘
        │                                 └─────────────────────────┘
        │
        │                          ┌──────────────────────────────────────────┐
        │                          │                sprints                   │
        │                          │──────────────────────────────────────────│
        │                          │ id (PK)                                  │
        │                          │ project_id (FK) ──────────────▶ projects │
        │                          │ name                                     │
        │                          │ goal                                     │
        │                          │ status (ENUM)                            │
        │                          │ start_date, end_date                     │
        │                          │ velocity                                 │
        │                          │ created_at, updated_at                   │
        │                          └──────────────────────────────────────────┘
        │                                         │ 1:N
        │                                         ▼
        │  ┌──────────────────────────────────────────────────────────────────────┐
        │  │                            issues                                    │
        │  │──────────────────────────────────────────────────────────────────────│
        │  │ id (PK)                                                              │
        │  │ issue_key (UNIQ)        ← generated from issue_key_counters         │
        │  │ project_id (FK) ─────────────────────────────────────▶ projects     │
        │  │ type (ENUM: EPIC/STORY/TASK/BUG/SUBTASK)                            │
        │  │ title                                                                │
        │  │ description                                                          │
        │  │ status_id (FK) ─────────────────────────────▶ workflow_statuses     │
        │  │ priority (ENUM)                                                      │
        │  │ assignee_id (FK, nullable) ──────────────────────────────▶ users    │
        │  │ reporter_id (FK) ────────────────────────────────────────▶ users    │
        │  │ parent_id (FK, nullable) ────────────────────────────────▶ issues   │  (self-ref)
        │  │ sprint_id (FK, nullable) ────────────────────────────────▶ sprints  │
        │  │ story_points                                                         │
        │  │ labels (JSON)                                                        │
        │  │ version    ← @VersionColumn for optimistic locking                  │
        │  │ created_at, updated_at, deleted_at                                  │
        │  └──────────────────────────────────────────────────────────────────────┘
        │          │ 1:N              │ 1:N                │ 1:N
        │          ▼                  ▼                    ▼
        │  ┌────────────┐  ┌──────────────────┐  ┌─────────────────────────┐
        │  │  comments  │  │  issue_watchers  │  │ custom_field_values     │
        │  │────────────│  │──────────────────│  │─────────────────────────│
        │  │ id (PK)    │  │ id (PK)          │  │ id (PK)                 │
        │  │ issue_id   │  │ issue_id (FK)    │  │ field_definition_id(FK) │
        │  │ author_id  │  │ user_id (FK)     │  │ issue_id (FK)           │
        │  │ parent_id  │  │ created_at       │  │ value (TEXT)            │
        │  │ content    │  └──────────────────┘  └─────────────────────────┘
        │  │ mentions   │                                    ▲
        │  │ created_at │                       ┌───────────┘
        │  │ updated_at │                       │ custom_field_definitions
        │  │ deleted_at │                       │──────────────────────────
        │  └────────────┘                       │ id (PK)
        │                                       │ project_id (FK) ▶ projects
        │                                       │ name, type, options, required
        │                                       └──────────────────────────────
        │
        │  ┌──────────────────────────────────┐
        │  │         activity_logs            │
        │  │──────────────────────────────────│
        │  │ id (PK)                          │
        │  │ project_id (FK)                  │
        │  │ actor_id (FK) ───────────────────┘ (FK to users)
        │  │ entity_type, entity_id           │
        │  │ action (ENUM)                    │
        │  │ old_value (JSON), new_value (JSON)│
        │  │ created_at                       │
        │  └──────────────────────────────────┘
        │
        │  ┌───────────────────────────────────┐
        └─▶│         notifications             │
           │───────────────────────────────────│
           │ id (PK)                           │
           │ user_id (FK) ─────────────────────┘ (FK to users)
           │ type (ENUM)                       │
           │ entity_type, entity_id            │
           │ message                           │
           │ read (BOOLEAN)                    │
           │ created_at                        │
           └───────────────────────────────────┘

  ┌──────────────────────────────────────┐
  │        issue_key_counters            │
  │ (no TypeORM entity — raw SQL only)   │
  │──────────────────────────────────────│
  │ project_id (PK, FK ▶ projects)       │
  │ counter (INT)                        │
  └──────────────────────────────────────┘
```

---

### 2.2 Entity Walkthrough

#### User (`src/models/User.ts`)

```typescript
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

  @OneToMany('ProjectMember', 'user')
  memberships!: ProjectMember[];
}
```

- `@PrimaryGeneratedColumn('uuid')` — TypeORM generates a UUID v4 before the INSERT. The `readonly` modifier in TypeScript prevents accidental reassignment.
- `@Column({ unique: true })` — TypeORM creates a `UNIQUE INDEX` on the `email` column. The database enforces uniqueness; the application does not have to do a pre-check.
- `@Column({ name: 'display_name' })` — the `name` option maps the camelCase TypeScript property to a snake_case column name. TypeORM does not automatically convert naming conventions.
- `passwordHash` — only the bcrypt digest is stored. The raw password never touches the database.
- `@CreateDateColumn` and `@UpdateDateColumn` — TypeORM sets these automatically. `created_at` is set once on INSERT. `updated_at` is updated on every save. Both are `readonly` in TypeScript because application code should never set them directly.
- `@OneToMany('ProjectMember', 'user')` — declares the inverse side of the ManyToOne on `ProjectMember`. Note that string references are used (`'ProjectMember'`) instead of direct class references to avoid circular import issues between modules.

#### Project (`src/models/Project.ts`)

```typescript
@DeleteDateColumn({ name: 'deleted_at' })
readonly deletedAt!: Date | null;
```

`@DeleteDateColumn` enables **soft delete**. When `repository.softDelete(id)` is called, TypeORM sets `deleted_at` to the current timestamp instead of issuing `DELETE FROM projects`. Every subsequent query issued through a `SoftDelete`-aware repository automatically adds `WHERE deleted_at IS NULL`. The row is invisible to normal queries but physically present, allowing recovery and audit.

The `key` column (`varchar(10), unique: true`) is the project prefix used in issue keys: a project with `key = 'PROJ'` produces issues `PROJ-1`, `PROJ-2`. It must be globally unique because issue keys are displayed without the project UUID.

#### ProjectMember (`src/models/ProjectMember.ts`)

```typescript
@Entity('project_members')
@Unique(['projectId', 'userId'])
export class ProjectMember {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'enum', enum: ProjectRole, default: ProjectRole.MEMBER })
  role!: ProjectRole;

  @CreateDateColumn({ name: 'joined_at' })
  readonly joinedAt!: Date;

  @ManyToOne('Project', 'members')
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne('User', 'memberships')
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
```

- `@Unique(['projectId', 'userId'])` — a class-level decorator that creates a composite unique constraint. This prevents the same user from being added to the same project twice. The constraint is at the database level, which is the only truly reliable place for it.
- `@Column({ type: 'enum', enum: ProjectRole })` — TypeORM creates a MySQL `ENUM` column. The allowed values come from the `ProjectRole` TypeScript enum. Any value outside the enum is rejected by MySQL before the application code can inspect it.
- `@ManyToOne('Project', 'members') @JoinColumn({ name: 'project_id' })` — the `@ManyToOne` declares the FK relationship. `@JoinColumn` specifies the physical column name. The second argument to `@ManyToOne` ('members') is the name of the inverse property on `Project`, which TypeORM uses to navigate the relationship in both directions.

#### Issue (`src/models/Issue.ts`)

The most complex entity. Key design decisions:

```typescript
@Entity('issues')
@Index('idx_issues_project_status',  ['projectId', 'statusId'])
@Index('idx_issues_project_sprint',  ['projectId', 'sprintId'])
@Index('idx_issues_project_created', ['projectId', 'createdAt'])
export class Issue {
```

The three class-level `@Index` decorators create composite indexes. These are not arbitrary — they are driven by the three most frequent query patterns:

| Index | Query it serves |
|---|---|
| `idx_issues_project_status` | Kanban board: all issues in a project grouped by status |
| `idx_issues_project_sprint` | Sprint backlog: all issues assigned to a sprint |
| `idx_issues_project_created` | Paginated issue list: issues in a project ordered by creation date |

```typescript
@Column({ name: 'parent_id', type: 'varchar', nullable: true })
parentId!: string | null;

@ManyToOne('Issue', { nullable: true })
@JoinColumn({ name: 'parent_id' })
parent!: Issue | null;
```

`parent_id` is a **self-referencing foreign key**: an Issue can reference another Issue as its parent. This enables the Epic → Story → Subtask hierarchy. When `parent_id` is NULL, the issue is a top-level item.

```typescript
@Column({ type: 'json', nullable: true })
labels!: string[];

@VersionColumn()
version!: number;
```

`labels` is a JSON column — an array of strings stored as a single database value. `@VersionColumn` is the optimistic locking marker discussed in section 1.4.

#### WorkflowStatus and WorkflowTransition

The workflow engine is a directed graph stored in two tables. `workflow_statuses` are the nodes; `workflow_transitions` are the edges.

```typescript
// WorkflowTransition has two FKs to the same table
@ManyToOne('WorkflowStatus')
@JoinColumn({ name: 'from_status_id' })
fromStatus!: WorkflowStatus;

@ManyToOne('WorkflowStatus')
@JoinColumn({ name: 'to_status_id' })
toStatus!: WorkflowStatus;
```

To check whether a transition is allowed before moving an issue, the application queries:

```sql
SELECT id FROM workflow_transitions
WHERE project_id = ?
  AND from_status_id = ?
  AND to_status_id   = ?
LIMIT 1;
```

If no row is returned, the transition is illegal. `WorkflowAutoAction` hangs off a transition: when the transition fires, all associated auto-actions execute. The `config` JSON column avoids needing a separate column for each action type's parameters.

#### ActivityLog (`src/models/ActivityLog.ts`)

```typescript
@Entity('activity_logs')
@Index('idx_activity_project_created', ['projectId', 'createdAt'])
@Index('idx_activity_entity', ['entityType', 'entityId'])
export class ActivityLog {
```

`ActivityLog` has no `@UpdateDateColumn` and no `@DeleteDateColumn`. Activity logs are **immutable audit records**. The migration comment states "append-only: no UPDATE or DELETE queries should ever touch this table." The absence of these columns is an intentional signal to developers reading the entity that mutation is not supported.

The `idx_activity_entity` composite index on `(entity_type, entity_id)` serves the query "show me the history of a specific issue": `WHERE entity_type = 'issue' AND entity_id = ?`.

#### CustomFieldDefinition and CustomFieldValue

This pair implements the **Entity-Attribute-Value (EAV)** pattern for extensible fields:

```typescript
// CustomFieldValue.ts
@Entity('custom_field_values')
@Unique(['fieldDefinitionId', 'issueId'])
export class CustomFieldValue {
  @Column({ type: 'text' })
  value!: string;
}
```

Every custom field value, regardless of type (text, number, date, dropdown), is stored as a string in `value`. The `CustomFieldDefinition.type` column tells the application how to parse it. This avoids an `ALTER TABLE` every time a new field type is needed. The `UNIQUE` constraint on `(field_definition_id, issue_id)` ensures at most one value per field per issue.

#### Notification (`src/models/Notification.ts`)

```typescript
@Index('idx_notifications_user_read_created', ['userId', 'read', 'createdAt'])
```

This three-column composite index is precisely engineered for the "inbox" query:

```sql
SELECT * FROM notifications
WHERE user_id  = ?
  AND read     = 0
ORDER BY created_at DESC
LIMIT 20;
```

All three predicates (`user_id`, `read`, `created_at`) are covered by the index. MySQL can satisfy this query by scanning only the relevant portion of the index without touching the table rows until it needs to return the final columns.

---

### 2.3 Optimistic Locking in Practice: The Two-User Scenario

Here is the exact sequence of events when two users edit the same issue simultaneously:

```
User A                              Database                     User B
──────                              ────────                     ──────
GET /issues/abc                       │                           │
                                      │◀─ SELECT * FROM issues    │
                                      │   WHERE id='abc'          │
                                      │   → {title:'Orig',v:3}    │
{title:'Orig', version:3}             │                           │
                                      │                    GET /issues/abc
                                      │◀─ SELECT * FROM issues
                                      │   WHERE id='abc'
                                      │   → {title:'Orig',v:3}
                                      │          {title:'Orig', version:3}
                                      │
PATCH /issues/abc {title:'A',v:3}     │                           │
                                      │                           │
          UPDATE issues               │                           │
          SET title='A',version=4     │                           │
          WHERE id='abc'              │                           │
            AND version=3             │                           │
          ──────────────────────────▶ │                           │
          Rows affected: 1 ✓          │                           │
          → HTTP 200                  │                   PATCH /issues/abc {title:'B',v:3}
                                      │
                                      │         UPDATE issues
                                      │         SET title='B',version=4
                                      │         WHERE id='abc'
                                      │           AND version=3
                                      │ ◀────────────────────────
                                      │  Rows affected: 0 ✗
                                      │  (version is now 4, not 3)
                                      │          → HTTP 409 Conflict
```

TypeORM raises `OptimisticLockVersionMismatchError` when `Rows affected = 0`. The service layer catches this and returns a structured 409 response. User B must re-fetch the issue, see User A's changes, and resubmit.

---

### 2.4 The `issue_key_counters` Pattern

The goal is to produce keys like `PROJ-1`, `PROJ-2`, `PROJ-3` with no gaps and no duplicates, even under concurrent inserts.

**Why `SELECT MAX(counter) + 1` is wrong:**

```
Thread A                Thread B
────────                ────────
SELECT MAX(counter)     SELECT MAX(counter)
FROM issue_key_counters FROM issue_key_counters
WHERE project_id='PROJ' WHERE project_id='PROJ'
→ 41                    → 41  (same read!)
INSERT issue key=PROJ-42   INSERT issue key=PROJ-42
                        UNIQUE CONSTRAINT VIOLATION
```

Both threads read 41 at the same time and both try to insert `PROJ-42`.

**The atomic solution** using `INSERT ... ON DUPLICATE KEY UPDATE`:

```sql
-- Step 1: Atomically increment (or initialise) the counter for this project
INSERT INTO issue_key_counters (project_id, counter)
VALUES ('project-uuid', 1)
ON DUPLICATE KEY UPDATE counter = counter + 1;

-- Step 2: Read back the value this connection just wrote
SELECT counter FROM issue_key_counters
WHERE project_id = 'project-uuid';
```

The `INSERT ... ON DUPLICATE KEY UPDATE` is atomic in InnoDB: it either inserts a new row (counter starts at 1) or atomically increments the existing row. No two concurrent executions can read the same post-increment value because the increment and the implicit lock are part of the same operation. The `SELECT` on the same connection immediately after reads the value from this connection's update, not a stale cache.

Migration 1781070144606 creates this table:

```sql
CREATE TABLE `issue_key_counters` (
  `project_id` varchar(36) NOT NULL,
  `counter`    int         NOT NULL DEFAULT 0,
  PRIMARY KEY (`project_id`)
) ENGINE=InnoDB
```

Note the migration comment: "This is not a TypeORM entity — it has no corresponding model class. IssueKeyGenerator issues raw SQL against this table directly." This is correct — TypeORM entities impose ORM overhead and optimistic locking that would be counterproductive here. The application issues the raw two-query sequence directly via `QueryRunner`.

---

### 2.5 Migration Sequence Walkthrough

The six migrations must run in exact order. Each migration depends on tables created by prior migrations.

```
Migration 601: create-user-and-project-tables
  Creates: users, projects, project_members
  FKs: projects → users (created_by)
       project_members → projects
       project_members → users
  Must run first: no dependencies

Migration 602: create-workflow-tables
  Creates: workflow_statuses, workflow_transitions, workflow_auto_actions
  FKs: workflow_statuses → projects       (requires 601)
       workflow_transitions → projects    (requires 601)
       workflow_transitions → workflow_statuses (requires self)
       workflow_auto_actions → workflow_transitions (requires self)
  Depends on: 601

Migration 603: create-sprint-and-issue-tables
  Creates: sprints, issues, issue_watchers
  FKs: sprints → projects                 (requires 601)
       issues → projects                  (requires 601)
       issues → workflow_statuses         (requires 602)
       issues → sprints                   (requires self)
       issues → users (assignee, reporter)(requires 601)
       issues → issues (parent, self-ref) (requires self)
       issue_watchers → issues            (requires self)
       issue_watchers → users             (requires 601)
  Depends on: 601, 602

Migration 604: create-collaboration-tables
  Creates: comments, activity_logs, custom_field_definitions,
           custom_field_values, notifications
  FKs: comments → issues                  (requires 603)
       comments → users                   (requires 601)
       comments → comments (self-ref)     (requires self)
       activity_logs → projects           (requires 601)
       activity_logs → users              (requires 601)
       custom_field_definitions → projects(requires 601)
       custom_field_values → custom_field_definitions (requires self)
       custom_field_values → issues       (requires 603)
       notifications → users              (requires 601)
  Depends on: 601, 603

Migration 605: add-search-indexes
  Adds: FULLTEXT INDEX on issues(title, description)
        FULLTEXT INDEX on comments(content)
  Depends on: 603, 604 (tables must exist)

Migration 606: create-issue-key-counters
  Creates: issue_key_counters
  No FK to other tables (FK would be useful but was intentionally omitted
  because this table uses raw SQL, not the ORM)
  Depends on: 601 (conceptually, counters are per-project)
```

If you tried to run migration 603 before migration 602, the `ADD CONSTRAINT FK_issues_status FOREIGN KEY (status_id) REFERENCES workflow_statuses(id)` would fail because `workflow_statuses` does not yet exist.

---

### 2.6 Full-Text Index Migration and Query Pattern

Migration 1781070144605 uses `ALTER TABLE ... ADD FULLTEXT INDEX` — syntax that TypeORM's schema synchroniser cannot generate:

```sql
ALTER TABLE `issues`
  ADD FULLTEXT INDEX `ft_issues_title_desc` (`title`, `description`);

ALTER TABLE `comments`
  ADD FULLTEXT INDEX `ft_comments_content` (`content`);
```

A full-text index on multiple columns is called a **multi-column full-text index**. MySQL treats all indexed columns as a single logical document. A search for "payment timeout" can match a row where "payment" appears in `title` and "timeout" appears in `description`.

The application's `SearchRepository` issues queries using `MATCH ... AGAINST`:

```sql
-- Natural language mode: relevance-ranked, stop words excluded
SELECT
  id,
  issue_key,
  title,
  MATCH(title, description) AGAINST('payment bug' IN NATURAL LANGUAGE MODE) AS score
FROM issues
WHERE MATCH(title, description) AGAINST('payment bug' IN NATURAL LANGUAGE MODE)
  AND project_id = ?
  AND deleted_at IS NULL
ORDER BY score DESC
LIMIT 20;
```

The `MATCH ... AGAINST` in the `WHERE` clause activates the full-text index. The same expression in the `SELECT` list returns the relevance score for sorting. MySQL assigns a relevance score based on term frequency and inverse document frequency (TF-IDF). Rows scoring zero are excluded automatically in natural language mode.

The migration comment warns about `innodb_ft_min_token_size` (default: 3). Words shorter than this threshold are not indexed. The word "bug" (3 characters) is included with the default setting, but "UI" (2 characters) would not be. If short-term search is needed, the MySQL variable must be lowered and the index rebuilt with `ALTER TABLE issues DROP INDEX ft_issues_title_desc; ALTER TABLE issues ADD FULLTEXT INDEX ...`.

---

### 2.7 TypeORM DataSource Configuration and Connection Pooling

The single source of truth for the database connection lives in `src/config/database.ts`:

```typescript
export const AppDataSource = new DataSource({
  type: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  synchronize: false,
  logging: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  entities: Object.values(models),
  migrations: [
    process.env.NODE_ENV === 'production'
      ? 'dist/migrations/*.js'
      : 'src/migrations/*.ts'
  ],
  extra: {
    connectionLimit: env.DB_POOL_MAX,
    waitForConnections: true,
    queueLimit: 0,
  },
});
```

Key decisions:

- `synchronize: false` — this is critical. When `synchronize: true`, TypeORM automatically alters the database schema on startup to match your entity definitions. This is useful for rapid local prototyping but is dangerous in production: it can drop columns, delete indexes, or apply changes out of order. This project forces all schema changes through migrations.
- `logging: ['query', 'error']` in development — every SQL statement is logged to the console. In production only errors are logged to avoid PII leakage and log volume.
- `entities: Object.values(models)` — imports the barrel export from `src/models/index.ts` (which re-exports all 14 entity classes) and registers them all. Adding a new entity to the barrel file is all that is needed to register it with TypeORM.
- `migrations` path — development runs TypeScript migrations directly (using `ts-node`); production uses the compiled `dist/migrations/*.js` output.
- `connectionLimit: env.DB_POOL_MAX` — the MySQL2 connection pool maximum. A pool maintains a set of open connections and reuses them across requests. Without pooling, each HTTP request would open and close a TCP connection to MySQL, adding ~10–50ms overhead per request. `waitForConnections: true` means requests queue when all pool connections are busy. `queueLimit: 0` means the queue is unlimited.

---

### 2.8 Soft Delete Pattern: `createdAt`, `updatedAt`, and `deletedAt`

The presence or absence of timestamp columns is not accidental:

| Table | `created_at` | `updated_at` | `deleted_at` |
|---|---|---|---|
| `users` | Yes | Yes | No |
| `projects` | Yes | Yes | Yes (soft delete) |
| `sprints` | Yes | Yes | No |
| `issues` | Yes | Yes | Yes (soft delete) |
| `comments` | Yes | Yes | Yes (soft delete) |
| `activity_logs` | Yes | No | No (immutable) |
| `workflow_statuses` | Yes | No | No |
| `workflow_transitions` | Yes | No | No |
| `workflow_auto_actions` | Yes | No | No |
| `notifications` | Yes | No | No |
| `issue_watchers` | Yes | No | No |
| `custom_field_values` | No | No | No |

**Soft delete (`deleted_at`)** applies to `projects`, `issues`, and `comments` — entities whose deletion must be recoverable and whose history must be preserved for audit purposes. Physically deleting an issue would destroy the associated `activity_logs`, `comments`, and `custom_field_values` (unless cascade deletes were configured, which they are not).

**No `updated_at`** on `activity_logs`, `workflow_statuses`, `workflow_transitions`, `workflow_auto_actions`, and `notifications` signals that these entities are either append-only (activity logs) or only created and deleted, never updated in place (workflow configuration is replaced, not patched field-by-field).

**No timestamps at all** on `custom_field_values` — the value changes atomically (upsert pattern), and the issue's own `updated_at` timestamp records when the change occurred.

---

## Key Takeaways

- **Normalise to 3NF by default; denormalise deliberately.** The `labels` and `mentions` JSON columns are intentional exceptions, documented in migration comments, chosen because the data is never a JOIN predicate.
- **Every composite index was designed for a specific query.** The three indexes on `issues` map directly to the board, sprint, and list access patterns. Adding an index without a matching query profile wastes write throughput and storage.
- **`synchronize: false` is non-negotiable in production.** Schema changes must flow through versioned, reviewed, reversible migration files — never applied ad hoc via TypeORM's auto-sync.
- **Optimistic locking with `@VersionColumn` is the right default for web applications.** It gives maximum read throughput and handles real conflicts explicitly (HTTP 409) rather than silently discarding one writer's work.
- **The `INSERT ... ON DUPLICATE KEY UPDATE` pattern for `issue_key_counters` is the only race-safe way to generate scoped sequential keys.** `SELECT MAX + 1` produces duplicates under concurrent load.
- **Foreign key constraints are a last line of defence, not a substitute for application validation.** They guarantee referential integrity even when bugs, direct SQL access, or message queue workers bypass application-layer checks.
- **UUIDs as primary keys enable ID generation before persistence**, which is valuable in event-driven and distributed architectures. Accept the index fragmentation trade-off when enumeration safety and distributed generation matter more than insert throughput.
- **Soft delete (`deleted_at`) preserves audit trails.** Physically deleting a project or issue would destroy the `activity_logs` and `comments` that reference it. Soft delete keeps the data invisible to normal queries while remaining available for history and recovery.

---

## Further Reading

- **"Database Design for Mere Mortals" by Michael J. Hernandez** — the most accessible treatment of relational data modelling, normal forms, and entity-relationship diagramming for practising developers.
- **MySQL 8.0 Reference Manual: Full-Text Search Functions** — https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html — authoritative documentation on `MATCH ... AGAINST`, natural language mode, boolean mode, and InnoDB full-text index configuration variables.
- **"Designing Data-Intensive Applications" by Martin Kleppmann (O'Reilly, 2017)** — Chapter 2 covers relational versus document models in depth; Chapter 7 covers transaction isolation, optimistic concurrency, and lost updates with rigorous examples.
- **TypeORM Documentation: Migrations** — https://typeorm.io/migrations — covers `migration:generate`, `migration:run`, `migration:revert`, and the `migrations` table that TypeORM maintains to track applied migrations.
- **"SQL Antipatterns" by Bill Karwin (Pragmatic Programmers, 2010)** — Chapters on ID required (surrogate keys), entity-attribute-value, and phantom files are directly relevant to design decisions made in this schema.
