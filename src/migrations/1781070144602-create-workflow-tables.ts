import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the workflow engine schema:
 *   workflow_statuses      — the Kanban columns for a project (TODO / IN_PROGRESS / DONE categories)
 *   workflow_transitions   — directed edges between statuses; defines which moves are legal
 *   workflow_auto_actions  — side-effects that fire automatically when a transition executes
 *                            (e.g. ASSIGN_REVIEWER, SET_FIELD)
 *
 * Design notes:
 *   - Statuses are project-scoped, not global, so each team can define their own workflow.
 *   - `wip_limit` on statuses is checked by WipLimitHook (Strategy pattern) before a transition
 *     is allowed. NULL means unlimited.
 *   - Transitions are explicit: a status move is only valid if a matching row exists in
 *     workflow_transitions. This prevents arbitrary jumps (e.g. TODO → DONE directly).
 *   - auto_actions.config is stored as JSON so new action types can be added without a
 *     schema migration.
 */
export class CreateWorkflowTables1781070144602 implements MigrationInterface {
  name = 'CreateWorkflowTables1781070144602';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── workflow_statuses ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`workflow_statuses\` (
        \`id\`          varchar(36)                         NOT NULL,
        \`project_id\`  varchar(255)                        NOT NULL,
        \`name\`        varchar(100)                        NOT NULL,
        \`category\`    enum('TODO','IN_PROGRESS','DONE')   NOT NULL DEFAULT 'TODO',
        \`position\`    int                                 NOT NULL DEFAULT 0,
        \`wip_limit\`   int                                 NULL,
        \`created_at\`  datetime(6)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── workflow_transitions ──────────────────────────────────────────────────
    // `name` is optional human-readable label for the transition button in the UI
    // (e.g. "Start Progress", "Send for Review").
    await queryRunner.query(`
      CREATE TABLE \`workflow_transitions\` (
        \`id\`             varchar(36)   NOT NULL,
        \`project_id\`     varchar(255)  NOT NULL,
        \`from_status_id\` varchar(255)  NOT NULL,
        \`to_status_id\`   varchar(255)  NOT NULL,
        \`name\`           varchar(100)  NULL,
        \`created_at\`     datetime(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── workflow_auto_actions ─────────────────────────────────────────────────
    // config JSON shape depends on type:
    //   ASSIGN_REVIEWER → { "assignTo": "current_user" }
    //   SET_FIELD       → { "field": "storyPoints", "value": 0 }
    //   NOTIFY          → { "template": "status_changed" }
    await queryRunner.query(`
      CREATE TABLE \`workflow_auto_actions\` (
        \`id\`            varchar(36)                             NOT NULL,
        \`transition_id\` varchar(255)                            NOT NULL,
        \`type\`          enum('ASSIGN_REVIEWER','SET_FIELD','NOTIFY') NOT NULL,
        \`config\`        json                                    NOT NULL,
        \`created_at\`    datetime(6)                             NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB
    `);

    // ── foreign keys ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE \`workflow_statuses\`
        ADD CONSTRAINT \`FK_workflow_statuses_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`workflow_transitions\`
        ADD CONSTRAINT \`FK_workflow_transitions_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`workflow_transitions\`
        ADD CONSTRAINT \`FK_workflow_transitions_from_status\`
        FOREIGN KEY (\`from_status_id\`) REFERENCES \`workflow_statuses\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`workflow_transitions\`
        ADD CONSTRAINT \`FK_workflow_transitions_to_status\`
        FOREIGN KEY (\`to_status_id\`) REFERENCES \`workflow_statuses\`(\`id\`)
    `);
    await queryRunner.query(`
      ALTER TABLE \`workflow_auto_actions\`
        ADD CONSTRAINT \`FK_workflow_auto_actions_transition\`
        FOREIGN KEY (\`transition_id\`) REFERENCES \`workflow_transitions\`(\`id\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`workflow_auto_actions\`  DROP FOREIGN KEY \`FK_workflow_auto_actions_transition\``);
    await queryRunner.query(`ALTER TABLE \`workflow_transitions\`   DROP FOREIGN KEY \`FK_workflow_transitions_to_status\``);
    await queryRunner.query(`ALTER TABLE \`workflow_transitions\`   DROP FOREIGN KEY \`FK_workflow_transitions_from_status\``);
    await queryRunner.query(`ALTER TABLE \`workflow_transitions\`   DROP FOREIGN KEY \`FK_workflow_transitions_project\``);
    await queryRunner.query(`ALTER TABLE \`workflow_statuses\`      DROP FOREIGN KEY \`FK_workflow_statuses_project\``);
    await queryRunner.query(`DROP TABLE \`workflow_auto_actions\``);
    await queryRunner.query(`DROP TABLE \`workflow_transitions\``);
    await queryRunner.query(`DROP TABLE \`workflow_statuses\``);
  }
}
