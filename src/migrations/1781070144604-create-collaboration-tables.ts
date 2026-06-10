import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the collaboration layer:
 *   comments               — threaded comments on issues; supports @mention tracking
 *   activity_logs          — append-only audit trail populated by domain event handlers
 *   custom_field_definitions — per-project custom field schemas (TEXT / NUMBER / DROPDOWN / DATE)
 *   custom_field_values    — one row per (field, issue) pair; value always stored as text
 *   notifications          — in-app notification inbox per user
 *
 * Design notes:
 *   - comments.mentions is a nullable JSON array of user IDs extracted at write time by
 *     MentionParser. It is denormalised (not a join table) because mentions are display-only
 *     and never need a reverse lookup from user → mentions. MySQL can't set a DDL DEFAULT on
 *     JSON columns; the application initialises it to [] on every insert.
 *   - activity_logs is append-only: no UPDATE or DELETE queries should ever touch this table.
 *     ActivityService subscribes to the domain EventBus ('*') and writes one row per event.
 *   - custom_field_values.value is always TEXT. Parsing to the typed value (number, date, etc.)
 *     is the application's responsibility. This avoids an ALTER TABLE whenever a new type is added.
 *   - notifications.read uses a composite index (user_id, read, created_at) to serve the common
 *     "show me my unread notifications, newest first" query without a full table scan.
 */
export class CreateCollaborationTables1781070144604 implements MigrationInterface {
  name = 'CreateCollaborationTables1781070144604';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── comments ──────────────────────────────────────────────────────────────
    // parent_id is NULL for top-level comments; set to a comment id for replies.
    // The index on (issue_id, created_at) serves the paginated comment list query.
    await queryRunner.query(`
      CREATE TABLE \`comments\` (
        \`id\`         varchar(36)  NOT NULL,
        \`issue_id\`   varchar(255) NOT NULL,
        \`author_id\`  varchar(255) NOT NULL,
        \`parent_id\`  varchar(255) NULL,
        \`content\`    text         NOT NULL,
        \`mentions\`   json         NULL,
        \`created_at\` datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`deleted_at\` datetime(6)  NULL,
        INDEX \`idx_comments_issue_created\` (\`issue_id\`, \`created_at\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── activity_logs ─────────────────────────────────────────────────────────
    // old_value / new_value are JSON so structured diffs can be stored without
    // knowing the schema of every entity up front.
    await queryRunner.query(`
      CREATE TABLE \`activity_logs\` (
        \`id\`          varchar(36)  NOT NULL,
        \`project_id\`  varchar(255) NOT NULL,
        \`actor_id\`    varchar(255) NOT NULL,
        \`entity_type\` varchar(50)  NOT NULL,
        \`entity_id\`   varchar(255) NOT NULL,
        \`action\`      enum(
                          'CREATED','UPDATED','STATUS_CHANGED',
                          'ASSIGNED','UNASSIGNED',
                          'SPRINT_ADDED','SPRINT_REMOVED',
                          'COMMENT_ADDED','COMMENT_UPDATED','COMMENT_DELETED'
                        )            NOT NULL,
        \`old_value\`   json         NULL,
        \`new_value\`   json         NULL,
        \`created_at\`  datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX \`idx_activity_entity\`          (\`entity_type\`, \`entity_id\`),
        INDEX \`idx_activity_project_created\` (\`project_id\`,  \`created_at\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── custom_field_definitions ──────────────────────────────────────────────
    // options is only populated for DROPDOWN fields; NULL for TEXT / NUMBER / DATE.
    await queryRunner.query(`
      CREATE TABLE \`custom_field_definitions\` (
        \`id\`         varchar(36)                         NOT NULL,
        \`project_id\` varchar(255)                        NOT NULL,
        \`name\`       varchar(100)                        NOT NULL,
        \`type\`       enum('TEXT','NUMBER','DROPDOWN','DATE') NOT NULL,
        \`options\`    json                                NULL,
        \`required\`   tinyint                             NOT NULL DEFAULT 0,
        \`position\`   int                                 NOT NULL DEFAULT 0,
        \`created_at\` datetime(6)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── custom_field_values ───────────────────────────────────────────────────
    // UNIQUE on (field_definition_id, issue_id) ensures at most one value per field per issue.
    await queryRunner.query(`
      CREATE TABLE \`custom_field_values\` (
        \`id\`                  varchar(36)  NOT NULL,
        \`field_definition_id\` varchar(255) NOT NULL,
        \`issue_id\`            varchar(255) NOT NULL,
        \`value\`               text         NOT NULL,
        UNIQUE INDEX \`UQ_custom_field_values_field_issue\` (\`field_definition_id\`, \`issue_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── notifications ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`notifications\` (
        \`id\`          varchar(36)                                    NOT NULL,
        \`user_id\`     varchar(255)                                   NOT NULL,
        \`type\`        enum('ASSIGNED','MENTIONED','STATUS_CHANGED','WATCHER') NOT NULL,
        \`entity_type\` varchar(50)                                    NOT NULL,
        \`entity_id\`   varchar(255)                                   NOT NULL,
        \`message\`     text                                           NOT NULL,
        \`read\`        tinyint                                        NOT NULL DEFAULT 0,
        \`created_at\`  datetime(6)                                    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX \`idx_notifications_user_read_created\` (\`user_id\`, \`read\`, \`created_at\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── foreign keys ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE \`comments\`
        ADD CONSTRAINT \`FK_comments_issue\`
        FOREIGN KEY (\`issue_id\`) REFERENCES \`issues\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`comments\`
        ADD CONSTRAINT \`FK_comments_author\`
        FOREIGN KEY (\`author_id\`) REFERENCES \`users\`(\`id\`)
    `);
    // Self-referencing FK: a reply's parent must be an existing comment on the same issue.
    await queryRunner.query(`
      ALTER TABLE \`comments\`
        ADD CONSTRAINT \`FK_comments_parent\`
        FOREIGN KEY (\`parent_id\`) REFERENCES \`comments\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`activity_logs\`
        ADD CONSTRAINT \`FK_activity_logs_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`activity_logs\`
        ADD CONSTRAINT \`FK_activity_logs_actor\`
        FOREIGN KEY (\`actor_id\`) REFERENCES \`users\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`custom_field_definitions\`
        ADD CONSTRAINT \`FK_custom_field_definitions_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`custom_field_values\`
        ADD CONSTRAINT \`FK_custom_field_values_definition\`
        FOREIGN KEY (\`field_definition_id\`) REFERENCES \`custom_field_definitions\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`custom_field_values\`
        ADD CONSTRAINT \`FK_custom_field_values_issue\`
        FOREIGN KEY (\`issue_id\`) REFERENCES \`issues\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`notifications\`
        ADD CONSTRAINT \`FK_notifications_user\`
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`notifications\`          DROP FOREIGN KEY \`FK_notifications_user\``);
    await queryRunner.query(`ALTER TABLE \`custom_field_values\`    DROP FOREIGN KEY \`FK_custom_field_values_issue\``);
    await queryRunner.query(`ALTER TABLE \`custom_field_values\`    DROP FOREIGN KEY \`FK_custom_field_values_definition\``);
    await queryRunner.query(`ALTER TABLE \`custom_field_definitions\` DROP FOREIGN KEY \`FK_custom_field_definitions_project\``);
    await queryRunner.query(`ALTER TABLE \`activity_logs\`          DROP FOREIGN KEY \`FK_activity_logs_actor\``);
    await queryRunner.query(`ALTER TABLE \`activity_logs\`          DROP FOREIGN KEY \`FK_activity_logs_project\``);
    await queryRunner.query(`ALTER TABLE \`comments\`               DROP FOREIGN KEY \`FK_comments_parent\``);
    await queryRunner.query(`ALTER TABLE \`comments\`               DROP FOREIGN KEY \`FK_comments_author\``);
    await queryRunner.query(`ALTER TABLE \`comments\`               DROP FOREIGN KEY \`FK_comments_issue\``);
    await queryRunner.query(`DROP TABLE \`notifications\``);
    await queryRunner.query(`DROP TABLE \`custom_field_values\``);
    await queryRunner.query(`DROP TABLE \`custom_field_definitions\``);
    await queryRunner.query(`DROP TABLE \`activity_logs\``);
    await queryRunner.query(`DROP TABLE \`comments\``);
  }
}
