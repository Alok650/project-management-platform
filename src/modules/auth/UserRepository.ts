import { AppDataSource } from '../../config/database';
import { User } from '../../models/User';

/** Data access layer for User entities */
export class UserRepository {
  private readonly repo = AppDataSource.getRepository(User);

  /** Find user by email address (case-sensitive) */
  findByEmail(email: string): Promise<User | null> {
    return this.repo.findOne({ where: { email } });
  }

  /** Find user by UUID primary key */
  findById(id: string): Promise<User | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** Resolve a list of @mention handles to user IDs via case-insensitive displayName match. */
  async resolveHandles(handles: string[]): Promise<string[]> {
    if (!handles.length) return [];
    const users = await AppDataSource.query(
      `SELECT id, LOWER(display_name) AS dn FROM users WHERE LOWER(display_name) IN (${handles.map(() => '?').join(',')})`,
      handles.map((h) => h.toLowerCase()),
    ) as Array<{ id: string; dn: string }>;
    return users.map((u) => u.id);
  }

  /** Persist a new or updated User */
  save(user: Partial<User>): Promise<User> {
    return this.repo.save(user);
  }
}
