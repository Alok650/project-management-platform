import { AppDataSource } from '../../config/database';
import { Issue } from '../../models/Issue';
import { IssueWatcher } from '../../models/IssueWatcher';
import { EntityManager } from 'typeorm';

/** Data access layer for Issue and IssueWatcher entities */
export class IssueRepository {
  private get repo() { return AppDataSource.getRepository(Issue); }
  private get watcherRepo() { return AppDataSource.getRepository(IssueWatcher); }

  /** Find an issue by UUID, optionally with eager relations */
  findById(id: string, relations?: string[]): Promise<Issue | null> {
    return this.repo.findOne({ where: { id }, relations });
  }

  /** Find an issue by its human-readable key (e.g. PROJ-42) */
  findByKey(issueKey: string): Promise<Issue | null> {
    return this.repo.findOne({ where: { issueKey } });
  }

  /**
   * Persist an issue. Accepts an optional EntityManager for transaction use.
   * @param data - Partial issue fields to save
   * @param em - Optional transaction entity manager
   */
  save(data: Partial<Issue>, em?: EntityManager): Promise<Issue> {
    const repo = em ? em.getRepository(Issue) : this.repo;
    return repo.save(data);
  }

  /** Soft-delete an issue (sets deleted_at) */
  softDelete(id: string): Promise<void> {
    return this.repo.softDelete(id).then(() => undefined);
  }

  /** Add a user as a watcher on an issue */
  addWatcher(issueId: string, userId: string): Promise<IssueWatcher> {
    return this.watcherRepo.save({ issueId, userId });
  }

  /** Remove a user watcher */
  removeWatcher(issueId: string, userId: string): Promise<void> {
    return this.watcherRepo.delete({ issueId, userId }).then(() => undefined);
  }

  /** List all watchers for an issue with their user data */
  getWatchers(issueId: string): Promise<IssueWatcher[]> {
    return this.watcherRepo.find({ where: { issueId }, relations: ['user'] });
  }
}
