import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the issue_key_counters table used by IssueKeyGenerator to produce
 * project-scoped, gap-free, race-safe issue keys (e.g. PROJ-1, PROJ-2, …).
 *
 * Why a custom table instead of AUTO_INCREMENT on the issues table?
 *   AUTO_INCREMENT on issues would produce monotonically increasing IDs globally,
 *   but issue keys are scoped per project. PROJ-1 and ACME-1 must both be possible.
 *
 * Why not a SELECT MAX(counter) + 1?
 *   Under concurrent inserts that pattern produces duplicates. The atomic
 *   INSERT … ON DUPLICATE KEY UPDATE counter = counter + 1 followed by a
 *   SELECT in the same connection returns the post-increment value without a
 *   separate lock.
 *
 * This is not a TypeORM entity — it has no corresponding model class.
 * IssueKeyGenerator issues raw SQL against this table directly.
 */
export class CreateIssueKeyCounters1781070144606 implements MigrationInterface {
  name = 'CreateIssueKeyCounters1781070144606';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`issue_key_counters\` (
        \`project_id\` varchar(36) NOT NULL,
        \`counter\`    int         NOT NULL DEFAULT 0,
        PRIMARY KEY (\`project_id\`)
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`issue_key_counters\``);
  }
}
