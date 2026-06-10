import { AppDataSource } from '../../config/database';
import { Sprint } from '../../models/Sprint';
import { Issue } from '../../models/Issue';
import { SprintStatus } from '../../core/types/enums';

/** Data access layer for Sprint entities */
export class SprintRepository {
  private readonly repo = AppDataSource.getRepository(Sprint);

  /** Find a sprint by its primary key */
  findById(id: string): Promise<Sprint | null>           { return this.repo.findOne({ where: { id } }); }

  /** Find all sprints for a project ordered by creation date */
  findByProject(projectId: string): Promise<Sprint[]>   { return this.repo.find({ where: { projectId }, order: { createdAt: 'ASC' } }); }

  /** Persist a sprint (insert or update) */
  save(data: Partial<Sprint>): Promise<Sprint>           { return this.repo.save(data); }

  /** Find the currently active sprint for a project */
  findActive(projectId: string): Promise<Sprint | null> {
    return this.repo.findOne({ where: { projectId, status: SprintStatus.ACTIVE } });
  }

  /** Get all non-DONE issues in a sprint (for carry-over logic) */
  getIncompleteIssues(sprintId: string): Promise<Issue[]> {
    return AppDataSource.getRepository(Issue)
      .createQueryBuilder('i')
      .innerJoin('i.status', 's')
      .where('i.sprintId = :sprintId AND s.category != :done AND i.deletedAt IS NULL', { sprintId, done: 'DONE' })
      .getMany();
  }

  /**
   * Compute sprint velocity: sum of story_points on completed issues.
   * @returns Total story points of DONE issues; 0 if none.
   */
  getVelocity(sprintId: string): Promise<number> {
    return AppDataSource.getRepository(Issue)
      .createQueryBuilder('i')
      .select('COALESCE(SUM(i.storyPoints), 0)', 'total')
      .innerJoin('i.status', 's')
      .where('i.sprintId = :sprintId AND s.category = :done AND i.deletedAt IS NULL', { sprintId, done: 'DONE' })
      .getRawOne()
      .then((r: { total: string } | undefined) => Number(r?.total ?? 0));
  }
}
