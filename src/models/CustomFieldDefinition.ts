import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, CreateDateColumn,
} from 'typeorm';
import type { Project } from './Project';
import { CustomFieldType } from '../core/types/enums';

/** Defines a custom field schema for a project */
@Entity('custom_field_definitions')
export class CustomFieldDefinition {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ type: 'enum', enum: CustomFieldType })
  type!: CustomFieldType;

  /** Allowed values for DROPDOWN fields; null for other types */
  @Column({ type: 'json', nullable: true })
  options!: string[] | null;

  @Column({ type: 'boolean', default: false })
  required!: boolean;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('Project')
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
