import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, DeleteDateColumn,
  ManyToOne, OneToMany, JoinColumn,
} from 'typeorm';
import type { User } from './User';
import type { ProjectMember } from './ProjectMember';
import type { WorkflowStatus } from './WorkflowStatus';

/** A workspace project — the root entity for issues, sprints, and workflow */
@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ length: 200 })
  name!: string;

  /** Short uppercase identifier used to prefix issue keys, e.g. "PROJ" */
  @Column({ length: 10, unique: true })
  key!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'created_by' })
  createdById!: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'created_by' })
  createdBy!: User;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  readonly deletedAt!: Date | null;

  @OneToMany('ProjectMember', 'project')
  members!: ProjectMember[];

  @OneToMany('WorkflowStatus', 'project')
  workflowStatuses!: WorkflowStatus[];
}
