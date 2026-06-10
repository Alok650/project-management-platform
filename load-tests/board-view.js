/**
 * Scenario: 100 concurrent board viewers
 *
 * What this tests:
 *   - Redis board cache (first request per project is a DB hit, subsequent are cache hits)
 *   - Cache invalidation: a small percentage of VUs create issues, forcing cache busts
 *   - Throughput and latency under mixed read/write load
 *
 * This is the primary SDE-2 load test target: p95 < 500ms at 100 VUs.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { authHeaders, login, checkOk, BASE_URL } from './helpers.js';

const boardLoadTime  = new Trend('board_load_time_ms', true);
const cacheHitRate   = new Rate('cache_hit_rate');
const errorRate      = new Rate('error_rate');

export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp-up
    { duration: '2m',  target: 100 },   // sustained load
    { duration: '30s', target: 0   },   // ramp-down
  ],
  thresholds: {
    http_req_duration:  ['p(95)<500'],   // SLO: 95th percentile under 500ms
    http_req_failed:    ['rate<0.01'],   // error budget: < 1% failures
    board_load_time_ms: ['p(99)<1000'],  // tail latency under 1s
    error_rate:         ['rate<0.02'],
  },
};

export function setup() {
  const token     = login(__ENV.K6_SEED_EMAIL || 'admin@demo.com', __ENV.K6_SEED_PASSWORD || 'password123');
  const projectId = __ENV.K6_PROJECT_ID;
  const sprintId  = __ENV.K6_SPRINT_ID || null;
  if (!projectId) throw new Error('K6_PROJECT_ID env var is required');
  console.log(`Board load test → project: ${projectId}, sprint: ${sprintId || 'backlog'}`);
  return { token, projectId, sprintId };
}

export default function ({ token, projectId, sprintId }) {
  const headers = authHeaders(token);

  // 85% of VUs read the board; 15% create an issue (forcing a cache bust)
  if (Math.random() < 0.85) {
    // ── board read ────────────────────────────────────────────────────────────
    const url   = `${BASE_URL}/api/v1/projects/${projectId}/board${sprintId ? `?sprintId=${sprintId}` : ''}`;
    const start = Date.now();
    const res   = http.get(url, { headers });
    boardLoadTime.add(Date.now() - start);

    const ok = check(res, {
      'board — status 200':        (r) => r.status === 200,
      'board — has columns array': (r) => {
        try { return Array.isArray(JSON.parse(r.body).data.columns); } catch { return false; }
      },
    });
    errorRate.add(!ok);

    // Detect cache hits: a cached response is typically < 20ms
    cacheHitRate.add(res.timings.duration < 20);
  } else {
    // ── issue create (cache invalidation path) ────────────────────────────────
    const res = http.post(
      `${BASE_URL}/api/v1/projects/${projectId}/issues`,
      JSON.stringify({ type: 'TASK', title: `Load test issue ${Date.now()}`, priority: 'MEDIUM' }),
      { headers },
    );
    errorRate.add(!checkOk(res, 'issue create'));
  }

  sleep(1);
}
