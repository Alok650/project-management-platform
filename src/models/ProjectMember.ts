import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import type { Project } from './Project';
import type { User } from './User';
import { ProjectRole } from '../core/types/enums';

/** Join table recording a user's membership and role within a project */
@Entity('project_members')
@Unique(['projectId', 'userId'])
export class ProjectMember {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'enum', enum: ProjectRole, default: ProjectRole.MEMBER })
  role!: ProjectRole;

  @CreateDateColumn({ name: 'joined_at' })
  readonly joinedAt!: Date;

  @ManyToOne('Project', 'members')
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne('User', 'memberships')
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
