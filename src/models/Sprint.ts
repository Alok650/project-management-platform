import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import type { Project } from './Project';
import { SprintStatus } from '../core/types/enums';

/** A time-boxed iteration used to plan and track issue delivery */
@Entity('sprints')
export class Sprint {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ length: 200 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  goal!: string | null;

  @Column({ type: 'enum', enum: SprintStatus, default: SprintStatus.PLANNING })
  status!: SprintStatus;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate!: string | null;

  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  /**
   * Total story points of DONE issues — computed and stored at sprint completion.
   * Null while the sprint is still active.
   */
  @Column({ type: 'int', nullable: true, default: null })
  velocity!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne('Project')
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
