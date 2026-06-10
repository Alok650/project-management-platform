import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, DeleteDateColumn,
  ManyToOne, JoinColumn, Index, VersionColumn,
} from 'typeorm';
import type { Project } from './Project';
import type { WorkflowStatus } from './WorkflowStatus';
import type { Sprint } from './Sprint';
import type { User } from './User';
import { IssueType, IssuePriority } from '../core/types/enums';

/** A unit of work — can be an Epic, Story, Task, Bug, or Subtask */
@Entity('issues')
@Index('idx_issues_project_status', ['projectId', 'statusId'])
@Index('idx_issues_project_sprint', ['projectId', 'sprintId'])
@Index('idx_issues_project_created', ['projectId', 'createdAt'])
export class Issue {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  /** Project-scoped human-readable key, e.g. PROJ-42 */
  @Column({ name: 'issue_key', length: 20 })
  @Index({ unique: true })
  issueKey!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ type: 'enum', enum: IssueType })
  type!: IssueType;

  @Column({ length: 500 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'status_id' })
  statusId!: string;

  @Column({ type: 'enum', enum: IssuePriority, default: IssuePriority.MEDIUM })
  priority!: IssuePriority;

  @Column({ type: 'varchar', name: 'assignee_id', nullable: true })
  assigneeId!: string | null;

  @Column({ name: 'reporter_id' })
  reporterId!: string;

  @Column({ type: 'varchar', name: 'parent_id', nullable: true })
  parentId!: string | null;

  @Column({ type: 'varchar', name: 'sprint_id', nullable: true })
  sprintId!: string | null;

  @Column({ name: 'story_points', type: 'int', nullable: true })
  storyPoints!: number | null;

  /** Label strings stored as JSON array; application must initialise to [] on insert */
  @Column({ type: 'json', nullable: true })
  labels!: string[];

  /** Incremented automatically by TypeORM on every save — used for optimistic locking */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  readonly deletedAt!: Date | null;

  @ManyToOne('Project')
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne('WorkflowStatus')
  @JoinColumn({ name: 'status_id' })
  status!: WorkflowStatus;

  @ManyToOne('Sprint', { nullable: true })
  @JoinColumn({ name: 'sprint_id' })
  sprint!: Sprint | null;

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'assignee_id' })
  assignee!: User | null;

  @ManyToOne('User')
  @JoinColumn({ name: 'reporter_id' })
  reporter!: User;

  @ManyToOne('Issue', { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent!: Issue | null;
}
