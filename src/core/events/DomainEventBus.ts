import { EventEmitter } from 'events';
import { AppDomainEvent } from './events';
import { logger } from '../../infrastructure/logger/Logger';

class DomainEventBus extends EventEmitter {
  /** Publish a domain event to all subscribers */
  publish(event: AppDomainEvent): void {
    logger.debug({ eventType: event.type, correlationId: event.correlationId }, 'Domain event published');
    this.emit(event.type, event);
    this.emit('*', event);
  }

  /**
   * Subscribe to a specific event type or all events via '*'
   * @param eventType - Event type string or '*' for all events
   * @param handler - Async or sync handler; errors are caught and logged
   */
  subscribe<T extends AppDomainEvent>(
    eventType: T['type'] | '*',
    handler: (event: T) => void | Promise<void>,
  ): void {
    this.on(eventType, (event: T) => {
      Promise.resolve(handler(event)).catch((err) =>
        logger.error({ err, eventType }, 'Event handler error'),
      );
    });
  }
}

export const eventBus = new DomainEventBus();
eventBus.setMaxListeners(50);
