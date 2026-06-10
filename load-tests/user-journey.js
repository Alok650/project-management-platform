/**
 * Scenario: Realistic mixed user journey
 *
 * Simulates what a real project team member does:
 *   1. View the board (read-heavy, benefits from cache)
 *   2. Open an issue detail
 *   3. Create a new issue
 *   4. Transition the issue status (exercises WorkflowEngine + cache bust)
 *   5. Add a comment with an @mention (exercises MentionParser + CommentAddedEvent)
 *   6. Search for issues
 *
 * This is the most representative test for overall system health.
 * Thresholds are looser than board-view.js because writes are slower.
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { authHeaders, login, randomItem, checkOk, BASE_URL } from './helpers.js';

const journeyErrors   = new Rate('journey_error_rate');
const stepDuration    = new Trend('step_duration_ms', true);

export const options = {
  vus:      50,
  duration: '3m',
  thresholds: {
    http_req_failed:   ['rate<0.02'],
    journey_error_rate: ['rate<0.05'],
    step_duration_ms:  ['p(95)<1000'],
  },
};

export function setup() {
  const token     = login(__ENV.K6_SEED_EMAIL || 'admin@demo.com', __ENV.K6_SEED_PASSWORD || 'password123');
  const projectId = __ENV.K6_PROJECT_ID;
  const sprintId  = __ENV.K6_SPRINT_ID || null;

  // Fetch a list of existing issues to open in the detail step
  const res    = http.get(`${BASE_URL}/api/v1/projects/${projectId}/issues?limit=20`, { headers: authHeaders(token) });
  const issues = JSON.parse(res.body).data?.items ?? [];
  const statusRes = http.get(`${BASE_URL}/api/v1/projects/${projectId}/board`, { headers: authHeaders(token) });
  const columns   = JSON.parse(statusRes.body).data?.columns ?? [];
  // Pick a non-DONE status to transition into
  const targetStatus = columns.find(c => c.category === 'IN_PROGRESS') ?? columns[0];

  console.log(`Journey test → ${issues.length} issues loaded, transition target: ${targetStatus?.statusName}`);
  return { token, projectId, sprintId, issueIds: issues.map(i => i.id), targetStatusId: targetStatus?.statusId };
}

export default function ({ token, projectId, sprintId, issueIds, targetStatusId }) {
  const headers = authHeaders(token);
  let createdIssueId = null;

  group('1 — view board', () => {
    const start = Date.now();
    const res   = http.get(
      `${BASE_URL}/api/v1/projects/${projectId}/board${sprintId ? `?sprintId=${sprintId}` : ''}`,
      { headers },
    );
    stepDuration.add(Date.now() - start);
    journeyErrors.add(!checkOk(res, 'board'));
  });

  sleep(1);

  group('2 — open issue detail', () => {
    if (!issueIds.length) return;
    const id    = randomItem(issueIds);
    const start = Date.now();
    const res   = http.get(`${BASE_URL}/api/v1/issues/${id}`, { headers });
    stepDuration.add(Date.now() - start);
    journeyErrors.add(!checkOk(res, 'issue detail'));
  });

  sleep(0.5);

  group('3 — create issue', () => {
    const start = Date.now();
    const res   = http.post(
      `${BASE_URL}/api/v1/projects/${projectId}/issues`,
      JSON.stringify({
        type:     'TASK',
        title:    `Journey task from VU ${__VU} — ${Date.now()}`,
        priority: 'MEDIUM',
      }),
      { headers },
    );
    stepDuration.add(Date.now() - start);
    if (res.status === 201) {
      createdIssueId = JSON.parse(res.body).data?.id ?? null;
    }
    journeyErrors.add(!checkOk(res, 'create issue'));
  });

  sleep(0.5);

  group('4 — transition status', () => {
    if (!createdIssueId || !targetStatusId) return;
    const start = Date.now();
    const res   = http.post(
      `${BASE_URL}/api/v1/issues/${createdIssueId}/transitions`,
      JSON.stringify({ toStatusId: targetStatusId }),
      { headers },
    );
    stepDuration.add(Date.now() - start);
    journeyErrors.add(!checkOk(res, 'transition'));
  });

  sleep(0.5);

  group('5 — add comment', () => {
    if (!createdIssueId) return;
    const start = Date.now();
    const res   = http.post(
      `${BASE_URL}/api/v1/issues/${createdIssueId}/comments`,
      JSON.stringify({ content: `Nice work @admin! Closing this one. (VU ${__VU})` }),
      { headers },
    );
    stepDuration.add(Date.now() - start);
    journeyErrors.add(!checkOk(res, 'comment'));
  });

  sleep(0.5);

  group('6 — search', () => {
    const start = Date.now();
    const res   = http.get(
      `${BASE_URL}/api/v1/projects/${projectId}/search?q=task`,
      { headers },
    );
    stepDuration.add(Date.now() - start);
    journeyErrors.add(!checkOk(res, 'search'));
  });

  sleep(2);
}
