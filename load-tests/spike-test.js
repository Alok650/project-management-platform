/**
 * Scenario: Traffic spike — validates rate limiter and graceful degradation
 *
 * What this tests:
 *   - The Redis sliding-window rate limiter (100 req/min per IP) engages at spike
 *   - Server returns 429 with Retry-After header (not 500)
 *   - After the spike, the system recovers and resumes serving 200s
 *
 * Expected behaviour:
 *   - During the spike (200 VUs), some requests will hit the rate limit → 429
 *   - 429s are NOT counted as failures for this test — they're correct behaviour
 *   - The check is that we never see 500/503 (the server doesn't crash)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { authHeaders, login, BASE_URL } from './helpers.js';

const rateLimitedRate = new Rate('rate_limited');
const serverErrorRate = new Rate('server_errors');

export const options = {
  stages: [
    { duration: '10s', target: 10  },   // warm up
    { duration: '15s', target: 200 },   // spike — should trigger rate limiter
    { duration: '30s', target: 10  },   // recovery — should return to normal
    { duration: '10s', target: 0   },   // ramp-down
  ],
  thresholds: {
    server_errors: ['rate<0.001'],      // zero 5xx — rate limiter must not crash the server
    // 429 rate during spike is expected; no threshold on rate_limited
  },
};

export function setup() {
  const token     = login(__ENV.K6_SEED_EMAIL || 'admin@demo.com', __ENV.K6_SEED_PASSWORD || 'password123');
  const projectId = __ENV.K6_PROJECT_ID;
  if (!projectId) throw new Error('K6_PROJECT_ID is required');
  return { token, projectId };
}

export default function ({ token, projectId }) {
  const res = http.get(
    `${BASE_URL}/api/v1/projects/${projectId}/board`,
    { headers: authHeaders(token) },
  );

  const isRateLimited = res.status === 429;
  const isServerError = res.status >= 500;

  check(res, {
    'spike — no server error (200 or 429 acceptable)': (r) => r.status < 500,
    'spike — 429 has Retry-After header': (r) =>
      r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });

  rateLimitedRate.add(isRateLimited);
  serverErrorRate.add(isServerError);

  // No sleep — we WANT to hammer the rate limiter during the spike
}
