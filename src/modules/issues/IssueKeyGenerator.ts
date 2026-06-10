import { AppDataSource } from '../../config/database';

/**
 * Factory that atomically generates project-scoped issue keys (e.g. PROJ-42).
 * Uses a dedicated counter table with INSERT … ON DUPLICATE KEY UPDATE to avoid races.
 */
export class IssueKeyGenerator {
  /**
   * Increment the counter for a project and return the next key.
   * @param projectId - UUID of the project
   * @param projectKey - Short uppercase key (e.g. "PROJ")
   */
  async next(projectId: string, projectKey: string): Promise<string> {
    // Both queries must run on the same connection so that SELECT LAST_INSERT_ID()
    // reads the value written by this connection's INSERT/UPDATE, not another
    // connection's. AppDataSource.transaction() holds a single connection for the
    // duration of the callback, which makes the LAST_INSERT_ID(expr) pattern safe.
    return AppDataSource.transaction(async (em) => {
      await em.query(
        `INSERT INTO issue_key_counters (project_id, counter) VALUES (?, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE counter = LAST_INSERT_ID(counter + 1)`,
        [projectId],
      );
      const [row] = await em.query(`SELECT LAST_INSERT_ID() AS counter`);
      return `${projectKey}-${(row as { counter: number }).counter}`;
    });
  }
}
