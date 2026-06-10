import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import type { Project } from './Project';
import type { WorkflowStatus } from './WorkflowStatus';
import type { WorkflowAutoAction } from './WorkflowAutoAction';

/** Defines an allowed status transition within a project workflow */
@Entity('workflow_transitions')
export class WorkflowTransition {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ name: 'from_status_id' })
  fromStatusId!: string;

  @Column({ name: 'to_status_id' })
  toStatusId!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('Project')
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne('WorkflowStatus')
  @JoinColumn({ name: 'from_status_id' })
  fromStatus!: WorkflowStatus;

  @ManyToOne('WorkflowStatus')
  @JoinColumn({ name: 'to_status_id' })
  toStatus!: WorkflowStatus;

  @OneToMany('WorkflowAutoAction', 'transition')
  autoActions!: WorkflowAutoAction[];
}
