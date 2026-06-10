import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import type { WorkflowTransition } from './WorkflowTransition';
import { AutoActionType } from '../core/types/enums';

/** An automatic action executed when a workflow transition fires */
@Entity('workflow_auto_actions')
export class WorkflowAutoAction {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'transition_id' })
  transitionId!: string;

  @Column({ type: 'enum', enum: AutoActionType })
  type!: AutoActionType;

  /**
   * JSON configuration for the action.
   * Example: { "assignTo": "current_user" } for ASSIGN_REVIEWER
   */
  @Column({ type: 'json' })
  config!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('WorkflowTransition', 'autoActions')
  @JoinColumn({ name: 'transition_id' })
  transition!: WorkflowTransition;
}
