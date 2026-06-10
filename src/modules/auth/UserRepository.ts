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

  /** Persist a new or updated User */
  save(user: Partial<User>): Promise<User> {
    return this.repo.save(user);
  }
}
