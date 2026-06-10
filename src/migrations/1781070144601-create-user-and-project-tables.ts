import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the identity and project-ownership layer:
 *   users            — platform accounts (auth credentials live here, not in a separate auth table)
 *   projects         — root aggregates; each project owns its own workflow, sprints, and issues
 *   project_members  — many-to-many join with an explicit role column (ADMIN / PROJECT_LEAD / MEMBER / VIEWER)
 *
 * Why a separate join table instead of a simple FK?
 *   A user can belong to multiple projects with different roles, so a join table is the correct model.
 *   The UNIQUE constraint on (project_id, user_id) prevents duplicate memberships at the DB level.
 */
export class CreateUserAndProjectTables1781070144601 implements MigrationInterface {
  name = 'CreateUserAndProjectTables1781070144601';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── users ─────────────────────────────────────────────────────────────────
    // password_hash stores a bcrypt digest; the raw password never touches the DB.
    await queryRunner.query(`
      CREATE TABLE \`users\` (
        \`id\`            varchar(36)   NOT NULL,
        \`email\`         varchar(255)  NOT NULL,
        \`display_name\`  varchar(100)  NOT NULL,
        \`password_hash\` varchar(255)  NOT NULL,
        \`created_at\`    datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`    datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        UNIQUE INDEX \`UQ_users_email\` (\`email\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── projects ──────────────────────────────────────────────────────────────
    // `key` is the short uppercase prefix used to generate human-readable issue keys (e.g. PROJ-42).
    // It must be globally unique because issue keys are displayed without the project UUID.
    await queryRunner.query(`
      CREATE TABLE \`projects\` (
        \`id\`          varchar(36)   NOT NULL,
        \`name\`        varchar(200)  NOT NULL,
        \`key\`         varchar(10)   NOT NULL,
        \`description\` text          NULL,
        \`created_by\`  varchar(255)  NOT NULL,
        \`created_at\`  datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`  datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`deleted_at\`  datetime(6)   NULL,
        UNIQUE INDEX \`UQ_projects_key\` (\`key\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── project_members ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`project_members\` (
        \`id\`          varchar(36)                                          NOT NULL,
        \`project_id\`  varchar(255)                                         NOT NULL,
        \`user_id\`     varchar(255)                                         NOT NULL,
        \`role\`        enum('ADMIN','PROJECT_LEAD','MEMBER','VIEWER')        NOT NULL DEFAULT 'MEMBER',
        \`joined_at\`   datetime(6)                                          NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        UNIQUE INDEX \`UQ_project_members_project_user\` (\`project_id\`, \`user_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── foreign keys ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD CONSTRAINT \`FK_projects_created_by\`
        FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_members\`
        ADD CONSTRAINT \`FK_project_members_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_members\`
        ADD CONSTRAINT \`FK_project_members_user\`
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`project_members\` DROP FOREIGN KEY \`FK_project_members_user\``);
    await queryRunner.query(`ALTER TABLE \`project_members\` DROP FOREIGN KEY \`FK_project_members_project\``);
    await queryRunner.query(`ALTER TABLE \`projects\`        DROP FOREIGN KEY \`FK_projects_created_by\``);
    await queryRunner.query(`DROP TABLE \`project_members\``);
    await queryRunner.query(`DROP TABLE \`projects\``);
    await queryRunner.query(`DROP TABLE \`users\``);
  }
}
