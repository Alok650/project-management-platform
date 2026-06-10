import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, DeleteDateColumn,
  ManyToOne, JoinColumn, Index,
} from 'typeorm';
import type { Issue } from './Issue';
import type { User } from './User';

/** A threaded comment on an issue, supporting @mention tracking */
@Entity('comments')
@Index('idx_comments_issue_created', ['issueId', 'createdAt'])
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'issue_id' })
  issueId!: string;

  @Column({ name: 'author_id' })
  authorId!: string;

  @Column({ type: 'varchar', name: 'parent_id', nullable: true })
  parentId!: string | null;

  @Column({ type: 'text' })
  content!: string;

  /** User IDs extracted from @mention syntax; application must initialise to [] on insert */
  @Column({ type: 'json', nullable: true })
  mentions!: string[];

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  readonly deletedAt!: Date | null;

  @ManyToOne('Issue')
  @JoinColumn({ name: 'issue_id' })
  issue!: Issue;

  @ManyToOne('User')
  @JoinColumn({ name: 'author_id' })
  author!: User;

  @ManyToOne('Comment', { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent!: Comment | null;
}
