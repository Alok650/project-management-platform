/**
 * Validates the generated OpenAPI 3.0 spec against the known API surface.
 *
 * Uses swagger-jsdoc to build the spec in-process (same as app.ts does at boot)
 * and asserts structural correctness without spinning up a server.
 */

import swaggerJsdoc from 'swagger-jsdoc';
import type { OpenAPIV3 } from 'openapi-types';

// ── Build spec once for all assertions ───────────────────────────────────────

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Project Management Platform API', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/modules/**/routes/**/*.ts'],
}) as OpenAPIV3.Document;

// ── Known route inventory ─────────────────────────────────────────────────────

const EXPECTED_PATHS: [string, string][] = [
  // Auth
  ['/api/v1/auth/register',                           'post'],
  ['/api/v1/auth/login',                              'post'],
  // Projects
  ['/api/v1/projects',                                'get'],
  ['/api/v1/projects',                                'post'],
  ['/api/v1/projects/{projectId}',                    'get'],
  ['/api/v1/projects/{projectId}',                    'patch'],
  ['/api/v1/projects/{projectId}',                    'delete'],
  ['/api/v1/projects/{projectId}/members',            'get'],
  ['/api/v1/projects/{projectId}/members',            'post'],
  ['/api/v1/projects/{projectId}/members/{userId}',   'delete'],
  // Issues
  ['/api/v1/projects/{projectId}/issues',             'get'],
  ['/api/v1/projects/{projectId}/issues',             'post'],
  ['/api/v1/projects/{projectId}/board',              'get'],
  ['/api/v1/issues/{issueId}',                        'get'],
  ['/api/v1/issues/{issueId}',                        'patch'],
  ['/api/v1/issues/{issueId}',                        'delete'],
  ['/api/v1/issues/{issueId}/transitions',            'post'],
  ['/api/v1/issues/{issueId}/watchers',               'post'],
  ['/api/v1/issues/{issueId}/watchers',               'delete'],
  // Sprints
  ['/api/v1/projects/{projectId}/sprints',            'get'],
  ['/api/v1/projects/{projectId}/sprints',            'post'],
  ['/api/v1/sprints/{sprintId}/start',                'post'],
  ['/api/v1/sprints/{sprintId}/complete',             'post'],
  // Comments
  ['/api/v1/issues/{issueId}/comments',               'get'],
  ['/api/v1/issues/{issueId}/comments',               'post'],
  ['/api/v1/comments/{commentId}',                    'patch'],
  ['/api/v1/comments/{commentId}',                    'delete'],
  // Search
  ['/api/v1/projects/{projectId}/search',             'get'],
  // Activity
  ['/api/v1/projects/{projectId}/activity',           'get'],
  // Health
  ['/api/health/live',                                'get'],
  ['/api/health/ready',                               'get'],
  ['/metrics',                                        'get'],
];

const EXPECTED_TAGS = ['Auth', 'Projects', 'Issues', 'Sprints', 'Comments', 'Search', 'Activity', 'Health'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOperation(path: string, method: string): OpenAPIV3.OperationObject | undefined {
  return (spec.paths?.[path] as Record<string, unknown>)?.[method] as OpenAPIV3.OperationObject | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenAPI spec — structural integrity', () => {

  // ── Meta ──────────────────────────────────────────────────────────────────

  it('is OpenAPI 3.0.x', () => {
    expect(spec.openapi).toMatch(/^3\.0\./);
  });

  it('has title and version in info', () => {
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
  });

  it('has bearerAuth security scheme defined', () => {
    const schemes = spec.components?.securitySchemes as Record<string, OpenAPIV3.SecuritySchemeObject>;
    expect(schemes?.['bearerAuth']).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('has global default security (bearerAuth)', () => {
    expect(spec.security).toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
  });

  // ── Tag coverage ──────────────────────────────────────────────────────────

  it('declares all expected tag groups', () => {
    const specTagNames = (spec.tags ?? []).map((t) => t.name);
    for (const tag of EXPECTED_TAGS) {
      expect(specTagNames).toContain(tag);
    }
  });

  // ── Path inventory ────────────────────────────────────────────────────────

  describe('documented paths', () => {
    it('spec contains at least 21 distinct paths', () => {
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThanOrEqual(21);
    });

    it.each(EXPECTED_PATHS)(
      'documents %s %s',
      (path, method) => {
        const op = getOperation(path, method);
        expect(op).toBeDefined();
      },
    );
  });

  // ── Operation-level rules ─────────────────────────────────────────────────

  describe('every operation', () => {
    const operations: [string, string, OpenAPIV3.OperationObject][] = [];
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods as object)) {
        if (['get','post','put','patch','delete'].includes(method)) {
          operations.push([path, method, op as OpenAPIV3.OperationObject]);
        }
      }
    }

    it.each(operations)(
      '%s %s — has at least one response defined',
      (_path, _method, op) => {
        expect(Object.keys(op.responses ?? {}).length).toBeGreaterThan(0);
      },
    );

    it.each(operations)(
      '%s %s — has a summary',
      (_path, _method, op) => {
        expect(typeof op.summary).toBe('string');
        expect((op.summary ?? '').length).toBeGreaterThan(0);
      },
    );

    it.each(operations)(
      '%s %s — has at least one tag',
      (_path, _method, op) => {
        expect(Array.isArray(op.tags)).toBe(true);
        expect((op.tags ?? []).length).toBeGreaterThan(0);
      },
    );
  });

  // ── Request body rules — mutations must document their body ───────────────

  const MUTATIONS_WITH_BODY: [string, string][] = [
    ['/api/v1/auth/register',                      'post'],
    ['/api/v1/auth/login',                         'post'],
    ['/api/v1/projects',                           'post'],
    ['/api/v1/projects/{projectId}',               'patch'],
    ['/api/v1/projects/{projectId}/members',       'post'],
    ['/api/v1/projects/{projectId}/issues',        'post'],
    ['/api/v1/issues/{issueId}',                   'patch'],
    ['/api/v1/issues/{issueId}/transitions',       'post'],
    ['/api/v1/projects/{projectId}/sprints',       'post'],
    ['/api/v1/sprints/{sprintId}/complete',        'post'],
    ['/api/v1/issues/{issueId}/comments',          'post'],
    ['/api/v1/comments/{commentId}',               'patch'],
  ];

  describe('mutations with request bodies', () => {
    it.each(MUTATIONS_WITH_BODY)(
      '%s %s — requestBody is documented with application/json schema',
      (path, method) => {
        const op = getOperation(path, method)!;
        expect(op?.requestBody).toBeDefined();
        const body = op.requestBody as OpenAPIV3.RequestBodyObject;
        expect(body.content?.['application/json']?.schema).toBeDefined();
      },
    );
  });

  // ── Path parameter rules ──────────────────────────────────────────────────

  const PATHS_WITH_PARAMS: [string, string[]][] = [
    ['/api/v1/projects/{projectId}',             ['projectId']],
    ['/api/v1/projects/{projectId}/issues',      ['projectId']],
    ['/api/v1/projects/{projectId}/board',       ['projectId']],
    ['/api/v1/projects/{projectId}/sprints',     ['projectId']],
    ['/api/v1/issues/{issueId}',                 ['issueId']],
    ['/api/v1/issues/{issueId}/transitions',     ['issueId']],
    ['/api/v1/issues/{issueId}/comments',        ['issueId']],
    ['/api/v1/comments/{commentId}',             ['commentId']],
    ['/api/v1/sprints/{sprintId}/start',         ['sprintId']],
    ['/api/v1/sprints/{sprintId}/complete',      ['sprintId']],
  ];

  describe('path parameters', () => {
    it.each(PATHS_WITH_PARAMS)(
      '%s — all path params are documented',
      (path, expectedParams) => {
        const pathItem = spec.paths?.[path] as Record<string, OpenAPIV3.OperationObject>;
        const allParams = new Set<string>();

        for (const method of ['get', 'post', 'patch', 'delete']) {
          const op = pathItem?.[method];
          if (!op) continue;
          const params = (op.parameters ?? []) as OpenAPIV3.ParameterObject[];
          params.filter((p) => p.in === 'path').forEach((p) => allParams.add(p.name));
        }

        for (const param of expectedParams) {
          expect(allParams).toContain(param);
        }
      },
    );
  });

  // ── Auth — public routes must override global security ────────────────────

  it('POST /api/v1/auth/register overrides security to [] (public)', () => {
    const op = getOperation('/api/v1/auth/register', 'post')!;
    expect(op.security).toEqual([]);
  });

  it('POST /api/v1/auth/login overrides security to [] (public)', () => {
    const op = getOperation('/api/v1/auth/login', 'post')!;
    expect(op.security).toEqual([]);
  });

  // ── Response codes — key business rules documented ────────────────────────

  it('PATCH /issues/{issueId} documents 409 (optimistic lock conflict)', () => {
    const op = getOperation('/api/v1/issues/{issueId}', 'patch')!;
    expect(op.responses?.['409']).toBeDefined();
  });

  it('POST /issues/{issueId}/transitions documents 422 (WIP / hook violation)', () => {
    const op = getOperation('/api/v1/issues/{issueId}/transitions', 'post')!;
    expect(op.responses?.['422']).toBeDefined();
  });

  it('POST /sprints/{sprintId}/start documents 409 (already active / wrong state)', () => {
    const op = getOperation('/api/v1/sprints/{sprintId}/start', 'post')!;
    expect(op.responses?.['409']).toBeDefined();
  });

  it('GET /api/health/ready documents 503 (dependency down)', () => {
    const op = getOperation('/api/health/ready', 'get')!;
    expect(op.responses?.['503']).toBeDefined();
  });

  it('GET /projects/{projectId}/search documents 400 (missing / short query)', () => {
    const op = getOperation('/api/v1/projects/{projectId}/search', 'get')!;
    expect(op.responses?.['400']).toBeDefined();
  });
});
