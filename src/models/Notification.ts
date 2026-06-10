import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn, Index,
} from 'typeorm';
import type { User } from './User';
import { NotifType } from '../core/types/enums';

/** In-app notification delivered to a user */
@Entity('notifications')
@Index('idx_notifications_user_read_created', ['userId', 'read', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  readonly id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ type: 'enum', enum: NotifType })
  type!: NotifType;

  @Column({ name: 'entity_type', length: 50 })
  entityType!: string;

  @Column({ name: 'entity_id' })
  entityId!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'boolean', default: false })
  read!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne('User')
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
