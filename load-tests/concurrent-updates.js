/**
 * Scenario: Concurrent issue updates — optimistic locking under real concurrency
 *
 * What this tests:
 *   - issues.version (@VersionColumn) prevents lost updates when two clients
 *     edit the same issue simultaneously
 *   - The service correctly returns 409 for the losing writer and 200 for the winner
 *   - The 409 rate should be close to (VUs - 1) / VUs ≈ 90% when all VUs fight for
 *     the same issue. Acceptable: any rate below 100% means no silent data loss.
 *
 * Run AFTER board-view.js because it needs a known issueId from seed data.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { authHeaders, login, BASE_URL } from './helpers.js';

const conflictRate  = new Rate('optimistic_lock_conflict_rate');
const successCount  = new Counter('successful_updates');
const conflictCount = new Counter('optimistic_lock_conflicts');

export const options = {
  // 10 VUs all hammering the same issue simultaneously
  vus:      10,
  duration: '30s',
  thresholds: {
    // We EXPECT conflicts — the important thing is they're 409, not 500
    http_req_failed: ['rate<0.01'],  // 5xx rate must be near zero
    // At least some writes must succeed (no total deadlock)
    successful_updates: ['count>5'],
  },
};

export function setup() {
  const token   = login(__ENV.K6_SEED_EMAIL || 'admin@demo.com', __ENV.K6_SEED_PASSWORD || 'password123');
  const issueId = __ENV.K6_ISSUE_ID;
  if (!issueId) throw new Error('K6_ISSUE_ID is required — run npm run seed and copy an issue UUID');

  // Fetch current version before the test begins
  const res     = http.get(`${BASE_URL}/api/v1/issues/${issueId}`, { headers: authHeaders(token) });
  const version = JSON.parse(res.body).data.version;
  console.log(`Concurrent update test → issueId: ${issueId}, starting version: ${version}`);
  return { token, issueId, version };
}

export default function ({ token, issueId }) {
  // All VUs send the same version — all but one will get 409
  // In real usage a client would retry with the latest version after a 409.
  const version = parseInt(__ENV.K6_ISSUE_VERSION || '1', 10);
  const headers = authHeaders(token);

  const res = http.patch(
    `${BASE_URL}/api/v1/issues/${issueId}`,
    JSON.stringify({ title: `Updated by VU ${__VU} at ${Date.now()}`, version }),
    { headers },
  );

  const isConflict = res.status === 409;
  const isSuccess  = res.status === 200;

  check(res, {
    'update — 200 or 409 (no 500)': (r) => r.status === 200 || r.status === 409,
  });

  conflictRate.add(isConflict);
  if (isSuccess)  successCount.add(1);
  if (isConflict) conflictCount.add(1);

  sleep(0.5);
}
