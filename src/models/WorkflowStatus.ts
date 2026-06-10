import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, CreateDateColumn,
} from 'typeorm';
import type { Project } from './Project';
import { StatusCategory } from '../core/types/enums';

/** A Kanban column / status within a project's workflow */
@Entity('workflow_statuses')
export class WorkflowStatus {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ type: 'enum', enum: StatusCategory, default: StatusCategory.TODO })
  category!: StatusCategory;

  /** Display order on the board (ascending) */
  @Column({ type: 'int', default: 0 })
  position!: number;

  /** Maximum number of issues allowed in this status; null = unlimited */
  @Column({ name: 'wip_limit', type: 'int', nullable: true })
  wipLimit!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('Project', 'workflowStatuses')
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
