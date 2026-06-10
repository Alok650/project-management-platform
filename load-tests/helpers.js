/**
 * Shared helpers for all load test scenarios.
 * Import with: import { authHeaders, randomItem, checkOk } from './helpers.js';
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';

/** Build Authorization header object from a JWT token */
export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Pick a random element from an array */
export function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Assert 2xx response and log failures.
 * Returns true if the check passed.
 */
export function checkOk(res, label) {
  return check(res, {
    [`${label} — status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${label} — no error body`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return !body.error;
      } catch { return false; }
    },
  });
}

/**
 * POST /api/v1/auth/login and return the JWT token.
 * Called inside k6 setup() to obtain tokens before the test begins.
 */
export function login(email, password) {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 200) throw new Error(`Login failed: ${res.body}`);
  return JSON.parse(res.body).data.accessToken;
}

export { BASE_URL };
