import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, JoinColumn, Unique,
} from 'typeorm';
import type { CustomFieldDefinition } from './CustomFieldDefinition';
import type { Issue } from './Issue';

/** Stores a custom field value for a specific issue; all types stored as text */
@Entity('custom_field_values')
@Unique(['fieldDefinitionId', 'issueId'])
export class CustomFieldValue {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'field_definition_id' })
  fieldDefinitionId!: string;

  @Column({ name: 'issue_id' })
  issueId!: string;

  /** Raw value as string — parsed to the appropriate type by the application layer */
  @Column({ type: 'text' })
  value!: string;

  @ManyToOne('CustomFieldDefinition')
  @JoinColumn({ name: 'field_definition_id' })
  fieldDefinition!: CustomFieldDefinition;

  @ManyToOne('Issue')
  @JoinColumn({ name: 'issue_id' })
  issue!: Issue;
}
