import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import type { User } from './User';
import type { Project } from './Project';
import { ActivityAction } from '../core/types/enums';

/** Immutable audit record for every mutation within a project */
@Entity('activity_logs')
@Index('idx_activity_project_created', ['projectId', 'createdAt'])
@Index('idx_activity_entity', ['entityType', 'entityId'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ name: 'actor_id' })
  actorId!: string;

  @Column({ name: 'entity_type', length: 50 })
  entityType!: string;

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'enum', enum: ActivityAction })
  action!: ActivityAction;

  @Column({ name: 'old_value', type: 'json', nullable: true })
  oldValue!: Record<string, unknown> | null;

  @Column({ name: 'new_value', type: 'json', nullable: true })
  newValue!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('Project')
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne('User')
  @JoinColumn({ name: 'actor_id' })
  actor!: User;
}
