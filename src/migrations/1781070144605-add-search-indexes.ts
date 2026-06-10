import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds FULLTEXT indexes required for the Search module.
 *
 * Why a separate migration?
 *   TypeORM's schema generator cannot produce FULLTEXT indexes — they must be written by hand.
 *   Keeping them in their own file makes it immediately obvious to reviewers that these indexes
 *   are search-specific additions and were not part of the base table definition.
 *
 * MySQL FULLTEXT behaviour:
 *   - NATURAL LANGUAGE MODE returns a relevance score; results with score = 0 are excluded.
 *   - The minimum word length for indexing is controlled by ft_min_word_len (default 4 in MyISAM,
 *     innodb_ft_min_token_size default 3 in InnoDB). Short terms like "bug" will not be indexed
 *     unless ft_min_word_len / innodb_ft_min_token_size is reduced to 2.
 *   - FULLTEXT indexes on InnoDB tables do not support DESC ordering; relevance score is always
 *     descending by nature of MATCH … AGAINST.
 */
export class AddSearchIndexes1781070144605 implements MigrationInterface {
  name = 'AddSearchIndexes1781070144605';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Covers: SearchRepository.searchIssues — MATCH(title, description) AGAINST(?)
    await queryRunner.query(`
      ALTER TABLE \`issues\`
        ADD FULLTEXT INDEX \`ft_issues_title_desc\` (\`title\`, \`description\`)
    `);

    // Covers: SearchRepository.searchComments — MATCH(content) AGAINST(?)
    await queryRunner.query(`
      ALTER TABLE \`comments\`
        ADD FULLTEXT INDEX \`ft_comments_content\` (\`content\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`comments\` DROP INDEX \`ft_comments_content\``);
    await queryRunner.query(`ALTER TABLE \`issues\`   DROP INDEX \`ft_issues_title_desc\``);
  }
}
