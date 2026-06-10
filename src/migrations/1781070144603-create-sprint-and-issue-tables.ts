import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the core planning primitives:
 *   sprints        — time-boxed iterations; velocity is computed and stored at completion
 *   issues         — the central work item (Epic / Story / Task / Bug / Subtask hierarchy)
 *   issue_watchers — subscription table so users receive notifications on watched issues
 *
 * Design notes:
 *   - issues.version is a TypeORM @VersionColumn for optimistic locking: IssueCommandService
 *     always requires the caller to echo back the current version. A mismatch returns 409.
 *   - issues.labels is a nullable JSON column (not a normalised tag table) because labels are
 *     display-only and never queried with a JOIN. MySQL 8 doesn't allow a DDL DEFAULT on JSON;
 *     the application layer initialises it to [] on every insert.
 *   - The three composite indexes on issues are the exact access patterns used by the board
 *     query (project+status), sprint filtering (project+sprint), and the cursor-paginated list
 *     (project+created_at).
 *   - sprints.velocity is NULL until the sprint is completed. SprintService.complete() runs a
 *     SUM(story_points) query and stores the result atomically under a MySQL advisory lock.
 */
export class CreateSprintAndIssueTables1781070144603 implements MigrationInterface {
  name = 'CreateSprintAndIssueTables1781070144603';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── sprints ───────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`sprints\` (
        \`id\`          varchar(36)                           NOT NULL,
        \`project_id\`  varchar(255)                          NOT NULL,
        \`name\`        varchar(200)                          NOT NULL,
        \`goal\`        text                                  NULL,
        \`status\`      enum('PLANNING','ACTIVE','COMPLETED') NOT NULL DEFAULT 'PLANNING',
        \`start_date\`  date                                  NULL,
        \`end_date\`    date                                  NULL,
        \`velocity\`    int                                   NULL,
        \`created_at\`  datetime(6)                           NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  datetime(6)                           NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── issues ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`issues\` (
        \`id\`           varchar(36)                                   NOT NULL,
        \`issue_key\`    varchar(20)                                   NOT NULL,
        \`project_id\`   varchar(255)                                  NOT NULL,
        \`type\`         enum('EPIC','STORY','TASK','BUG','SUBTASK')   NOT NULL,
        \`title\`        varchar(500)                                  NOT NULL,
        \`description\`  text                                          NULL,
        \`status_id\`    varchar(255)                                  NOT NULL,
        \`priority\`     enum('HIGHEST','HIGH','MEDIUM','LOW','LOWEST') NOT NULL DEFAULT 'MEDIUM',
        \`assignee_id\`  varchar(255)                                  NULL,
        \`reporter_id\`  varchar(255)                                  NOT NULL,
        \`parent_id\`    varchar(255)                                  NULL,
        \`sprint_id\`    varchar(255)                                  NULL,
        \`story_points\` int                                           NULL,
        \`labels\`       json                                          NULL,
        \`version\`      int                                           NOT NULL DEFAULT 1,
        \`created_at\`   datetime(6)                                   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`   datetime(6)                                   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`deleted_at\`   datetime(6)                                   NULL,
        UNIQUE INDEX \`UQ_issues_key\`               (\`issue_key\`),
        INDEX          \`idx_issues_project_status\`  (\`project_id\`, \`status_id\`),
        INDEX          \`idx_issues_project_sprint\`  (\`project_id\`, \`sprint_id\`),
        INDEX          \`idx_issues_project_created\` (\`project_id\`, \`created_at\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── issue_watchers ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`issue_watchers\` (
        \`id\`         varchar(36)  NOT NULL,
        \`issue_id\`   varchar(255) NOT NULL,
        \`user_id\`    varchar(255) NOT NULL,
        \`created_at\` datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE INDEX \`UQ_issue_watchers_issue_user\` (\`issue_id\`, \`user_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── foreign keys ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE \`sprints\`
        ADD CONSTRAINT \`FK_sprints_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_status\`
        FOREIGN KEY (\`status_id\`) REFERENCES \`workflow_statuses\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_sprint\`
        FOREIGN KEY (\`sprint_id\`) REFERENCES \`sprints\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_assignee\`
        FOREIGN KEY (\`assignee_id\`) REFERENCES \`users\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_reporter\`
        FOREIGN KEY (\`reporter_id\`) REFERENCES \`users\`(\`id\`)
    `);
    // Self-referencing FK for Epic → Story / Story → Subtask hierarchy
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD CONSTRAINT \`FK_issues_parent\`
        FOREIGN KEY (\`parent_id\`) REFERENCES \`issues\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issue_watchers\`
        ADD CONSTRAINT \`FK_issue_watchers_issue\`
        FOREIGN KEY (\`issue_id\`) REFERENCES \`issues\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`issue_watchers\`
        ADD CONSTRAINT \`FK_issue_watchers_user\`
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`issue_watchers\` DROP FOREIGN KEY \`FK_issue_watchers_user\``);
    await queryRunner.query(`ALTER TABLE \`issue_watchers\` DROP FOREIGN KEY \`FK_issue_watchers_issue\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_parent\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_reporter\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_assignee\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_sprint\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_status\``);
    await queryRunner.query(`ALTER TABLE \`issues\`         DROP FOREIGN KEY \`FK_issues_project\``);
    await queryRunner.query(`ALTER TABLE \`sprints\`        DROP FOREIGN KEY \`FK_sprints_project\``);
    await queryRunner.query(`DROP TABLE \`issue_watchers\``);
    await queryRunner.query(`DROP TABLE \`issues\``);
    await queryRunner.query(`DROP TABLE \`sprints\``);
  }
}
