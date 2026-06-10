/** Base interface for all domain events */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}
