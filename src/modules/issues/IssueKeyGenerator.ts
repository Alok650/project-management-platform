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
    await AppDataSource.query(
      `INSERT INTO issue_key_counters (project_id, counter) VALUES (?, 1)
       ON DUPLICATE KEY UPDATE counter = counter + 1`,
      [projectId],
    );
    const [row] = await AppDataSource.query(
      `SELECT counter FROM issue_key_counters WHERE project_id = ?`,
      [projectId],
    );
    return `${projectKey}-${(row as { counter: number }).counter}`;
  }
}
