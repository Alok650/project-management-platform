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
    // LAST_INSERT_ID(expr) stores expr as the connection-local last-insert-id.
    // Reading it back via SELECT LAST_INSERT_ID() is therefore safe under any
    // concurrency level — each connection sees only its own incremented value,
    // preventing the TOCTOU race that causes duplicate issue keys.
    await AppDataSource.query(
      `INSERT INTO issue_key_counters (project_id, counter) VALUES (?, LAST_INSERT_ID(1))
       ON DUPLICATE KEY UPDATE counter = LAST_INSERT_ID(counter + 1)`,
      [projectId],
    );
    const [row] = await AppDataSource.query(`SELECT LAST_INSERT_ID() AS counter`);
    return `${projectKey}-${(row as { counter: number }).counter}`;
  }
}
