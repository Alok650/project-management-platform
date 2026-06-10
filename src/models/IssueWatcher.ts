import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import type { Issue } from './Issue';
import type { User } from './User';

/** Records a user's watch subscription on an issue */
@Entity('issue_watchers')
@Unique(['issueId', 'userId'])
export class IssueWatcher {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'issue_id' })
  issueId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('Issue')
  @JoinColumn({ name: 'issue_id' })
  issue!: Issue;

  @ManyToOne('User')
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
