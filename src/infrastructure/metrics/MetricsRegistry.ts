import { Registry, Counter, Histogram, Gauge } from 'prom-client';

/** Singleton Prometheus metrics registry with pre-registered application metrics */
export class MetricsRegistry {
  private static instance: MetricsRegistry;

  readonly registry:              Registry;
  readonly httpRequestDuration:   Histogram<string>;
  readonly httpRequestTotal:      Counter<string>;
  readonly activeConnections:     Gauge<string>;
  readonly domainEventsTotal:     Counter<string>;

  private constructor() {
    this.registry = new Registry();

    this.httpRequestDuration = new Histogram({
      name:       'http_request_duration_seconds',
      help:       'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers:  [this.registry],
    });

    this.httpRequestTotal = new Counter({
      name:       'http_requests_total',
      help:       'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers:  [this.registry],
    });

    this.activeConnections = new Gauge({
      name:      'active_connections',
      help:      'Number of active HTTP connections',
      registers: [this.registry],
    });

    this.domainEventsTotal = new Counter({
      name:       'domain_events_total',
      help:       'Total number of domain events published',
      labelNames: ['type'],
      registers:  [this.registry],
    });
  }

  /** Get or create the singleton registry */
  static getInstance(): MetricsRegistry {
    if (!MetricsRegistry.instance) MetricsRegistry.instance = new MetricsRegistry();
    return MetricsRegistry.instance;
  }
}

export const metricsRegistry = MetricsRegistry.getInstance();
