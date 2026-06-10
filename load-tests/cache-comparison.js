/**
 * Cache comparison load test
 *
 * Two back-to-back k6 scenarios against the same endpoints:
 *
 *   cold_phase (0s–15s)  — 20 VUs hit all cached endpoints right after Redis flush.
 *                          Most requests are DB hits (cache miss path).
 *
 *   warm_phase (20s–50s) — 20 VUs hit the same endpoints.
 *                          Cache is now warm: board, membership, sprint list,
 *                          entity cache all serve from Redis.
 *
 * Tracks separate Trend metrics per phase so p50/p95/p99 are directly comparable.
 *
 * Before running:
 *   redis-cli FLUSHDB    # flush the DB used by the app (default: db 0)
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { authHeaders, login, BASE_URL } from './helpers.js';

// ── Custom metrics ────────────────────────────────────────────────────────────

const boardCold   = new Trend('board_cold_ms',   true);
const boardWarm   = new Trend('board_warm_ms',   true);
const rbacCold    = new Trend('rbac_cold_ms',    true);
const rbacWarm    = new Trend('rbac_warm_ms',    true);
const entityCold  = new Trend('entity_cold_ms',  true);
const entityWarm  = new Trend('entity_warm_ms',  true);
const sprintsCold = new Trend('sprints_cold_ms', true);
const sprintsWarm = new Trend('sprints_warm_ms', true);
const errorRate   = new Rate('error_rate');
const cacheErrors = new Counter('unexpected_errors');

// ── k6 scenarios ─────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    cold_phase: {
      executor:    'constant-vus',
      exec:        'coldRun',
      vus:         20,
      duration:    '15s',
      startTime:   '0s',
      gracefulStop: '5s',
      tags:        { phase: 'cold' },
    },
    warm_phase: {
      executor:    'constant-vus',
      exec:        'warmRun',
      vus:         20,
      duration:    '30s',
      startTime:   '20s',   // 5-second gap lets last cold requests' cache writes settle
      gracefulStop: '5s',
      tags:        { phase: 'warm' },
    },
  },
  thresholds: {
    // Warm cache must be materially faster than cold
    'board_warm_ms':   ['p(95)<50'],    // Redis GET — should be sub-10ms
    'board_cold_ms':   ['p(95)<500'],   // DB query — acceptable first-hit cost
    'rbac_warm_ms':    ['p(95)<30'],
    'sprints_warm_ms': ['p(95)<50'],
    'error_rate':      ['rate<0.02'],
  },
};

const NUM_VUS = 20;

// ── Setup — runs once before scenarios start ──────────────────────────────────
// Creates NUM_VUS unique test users so each VU has its own rate-limit bucket.

export function setup() {
  const projectId = __ENV.K6_PROJECT_ID;
  const sprintId  = __ENV.K6_SPRINT_ID  || null;
  const issueId   = __ENV.K6_ISSUE_ID   || null;
  if (!projectId) throw new Error('K6_PROJECT_ID env var required');

  // Admin token needed to add new members to the project
  const adminToken = login(__ENV.K6_SEED_EMAIL || 'admin@demo.com',
                           __ENV.K6_SEED_PASSWORD || 'password123');

  const tokens = [];
  const runId  = Date.now();

  for (let i = 0; i < NUM_VUS; i++) {
    const email    = `k6-vu${i}-${runId}@loadtest.local`;
    const password = 'LoadTest123!';

    // Register the VU-specific user
    const reg = http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({ email, password, displayName: `K6 VU ${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (reg.status !== 201) {
      throw new Error(`VU ${i} register failed (${reg.status}): ${reg.body}`);
    }

    // Add the new user as VIEWER on the project
    const userId = JSON.parse(reg.body).data.user.id;
    http.post(
      `${BASE_URL}/api/v1/projects/${projectId}/members`,
      JSON.stringify({ userId, role: 'VIEWER' }),
      { headers: authHeaders(adminToken) },
    );

    tokens.push(login(email, password));
  }

  console.log(`Cache comparison → project: ${projectId}  sprint: ${sprintId || 'backlog'}  VUs: ${tokens.length}`);
  return { tokens, projectId, sprintId, issueId };
}

// ── Cold scenario — runs while cache is empty ────────────────────────────────

export function coldRun({ token, projectId, sprintId, issueId }) {
  const h = authHeaders(token);

  // 1. Board view (cold) — hits MySQL via IssueQueryService.getBoardView
  group('board cold', () => {
    const t = Date.now();
    const r = http.get(
      `${BASE_URL}/api/v1/projects/${projectId}/board${sprintId ? `?sprintId=${sprintId}` : ''}`,
      { headers: h },
    );
    boardCold.add(Date.now() - t);
    const ok = check(r, { 'board 200': (res) => res.status === 200 });
    errorRate.add(!ok);
    if (!ok) cacheErrors.add(1);
  });

  // 2. RBAC-gated endpoint (cold) — membership lookup hits MySQL
  group('rbac cold', () => {
    const t = Date.now();
    const r = http.get(`${BASE_URL}/api/v1/projects/${projectId}`, { headers: h });
    rbacCold.add(Date.now() - t);
    check(r, { 'project 200': (res) => res.status === 200 });
  });

  // 3. Sprint list (cold) — hits MySQL
  group('sprints cold', () => {
    const t = Date.now();
    const r = http.get(`${BASE_URL}/api/v1/projects/${projectId}/sprints`, { headers: h });
    sprintsCold.add(Date.now() - t);
    check(r, { 'sprints 200': (res) => res.status === 200 });
  });

  // 4. Issue entity (cold) — hits MySQL if issueId provided
  if (issueId) {
    group('entity cold', () => {
      const t = Date.now();
      const r = http.get(`${BASE_URL}/api/v1/issues/${issueId}`, { headers: h });
      entityCold.add(Date.now() - t);
      check(r, { 'issue 200': (res) => res.status === 200 });
    });
  }

  sleep(0.1);
}

// ── Warm scenario — runs after cache has been populated ───────────────────────

export function warmRun({ token, projectId, sprintId, issueId }) {
  const h = authHeaders(token);

  group('board warm', () => {
    const t = Date.now();
    const r = http.get(
      `${BASE_URL}/api/v1/projects/${projectId}/board${sprintId ? `?sprintId=${sprintId}` : ''}`,
      { headers: h },
    );
    boardWarm.add(Date.now() - t);
    const ok = check(r, { 'board 200': (res) => res.status === 200 });
    errorRate.add(!ok);
  });

  group('rbac warm', () => {
    const t = Date.now();
    const r = http.get(`${BASE_URL}/api/v1/projects/${projectId}`, { headers: h });
    rbacWarm.add(Date.now() - t);
    check(r, { 'project 200': (res) => res.status === 200 });
  });

  group('sprints warm', () => {
    const t = Date.now();
    const r = http.get(`${BASE_URL}/api/v1/projects/${projectId}/sprints`, { headers: h });
    sprintsWarm.add(Date.now() - t);
    check(r, { 'sprints 200': (res) => res.status === 200 });
  });

  if (issueId) {
    group('entity warm', () => {
      const t = Date.now();
      const r = http.get(`${BASE_URL}/api/v1/issues/${issueId}`, { headers: h });
      entityWarm.add(Date.now() - t);
      check(r, { 'issue 200': (res) => res.status === 200 });
    });
  }

  sleep(0.1);
}
