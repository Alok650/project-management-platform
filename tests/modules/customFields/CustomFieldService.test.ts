/**
 * Unit tests for CustomFieldService.
 *
 * Focuses on value type validation (assertValidValue) and the
 * project-scoping guard on setValue/deleteDefinition.
 */

const mockListDefinitions  = jest.fn();
const mockFindDefinitionById = jest.fn();
const mockSaveDefinition   = jest.fn();
const mockDeleteDefinition = jest.fn();
const mockListValues       = jest.fn();
const mockFindValue        = jest.fn();
const mockSaveValue        = jest.fn();
const mockDeleteValue      = jest.fn();

jest.mock('../../../src/modules/customFields/CustomFieldRepository', () => ({
  CustomFieldRepository: jest.fn().mockImplementation(() => ({
    listDefinitions:    mockListDefinitions,
    findDefinitionById: mockFindDefinitionById,
    saveDefinition:     mockSaveDefinition,
    deleteDefinition:   mockDeleteDefinition,
    listValues:         mockListValues,
    findValue:          mockFindValue,
    saveValue:          mockSaveValue,
    deleteValue:        mockDeleteValue,
  })),
}));

const mockFindIssueById = jest.fn();

jest.mock('../../../src/modules/issues/IssueRepository', () => ({
  IssueRepository: jest.fn().mockImplementation(() => ({
    findById: mockFindIssueById,
  })),
}));

import { CustomFieldService } from '../../../src/modules/customFields/CustomFieldService';
import { CustomFieldRepository } from '../../../src/modules/customFields/CustomFieldRepository';
import { IssueRepository } from '../../../src/modules/issues/IssueRepository';
import { CustomFieldType } from '../../../src/core/types/enums';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../src/core/errors/errors';

const PROJECT_ID = 'proj-1';
const ISSUE_ID   = 'issue-1';
const FIELD_ID   = 'field-1';

function makeService(): CustomFieldService {
  return new CustomFieldService(new CustomFieldRepository() as any, new IssueRepository() as any);
}

function stubIssue() {
  mockFindIssueById.mockResolvedValue({ id: ISSUE_ID, projectId: PROJECT_ID });
}

function stubDef(type: CustomFieldType, options: string[] | null = null) {
  mockFindDefinitionById.mockResolvedValue({
    id: FIELD_ID, projectId: PROJECT_ID, type, options, name: 'Test field',
    required: false, position: 0,
  });
}

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// createDefinition — DROPDOWN requires options
// ─────────────────────────────────────────────────────────────────────────────

describe('createDefinition', () => {
  it('DROPDOWN without options throws ValidationError', async () => {
    const svc = makeService();
    await expect(
      svc.createDefinition(PROJECT_ID, { name: 'Tier', type: CustomFieldType.DROPDOWN }),
    ).rejects.toThrow(ValidationError);
  });

  it('DROPDOWN with options saves successfully', async () => {
    mockSaveDefinition.mockResolvedValue({ id: FIELD_ID });
    const svc = makeService();
    await svc.createDefinition(PROJECT_ID, { name: 'Tier', type: CustomFieldType.DROPDOWN, options: ['A', 'B'] });
    expect(mockSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({ options: ['A', 'B'] }));
  });

  it('TEXT field strips options to null', async () => {
    mockSaveDefinition.mockResolvedValue({ id: FIELD_ID });
    const svc = makeService();
    await svc.createDefinition(PROJECT_ID, { name: 'Notes', type: CustomFieldType.TEXT });
    expect(mockSaveDefinition).toHaveBeenCalledWith(expect.objectContaining({ options: null }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteDefinition — project ownership guard
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteDefinition', () => {
  it('throws ForbiddenError when field belongs to different project', async () => {
    mockFindDefinitionById.mockResolvedValue({ id: FIELD_ID, projectId: 'other-project' });
    await expect(makeService().deleteDefinition(FIELD_ID, PROJECT_ID)).rejects.toThrow(ForbiddenError);
  });

  it('throws NotFoundError when field does not exist', async () => {
    mockFindDefinitionById.mockResolvedValue(null);
    await expect(makeService().deleteDefinition(FIELD_ID, PROJECT_ID)).rejects.toThrow(NotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setValue — type validation
// ─────────────────────────────────────────────────────────────────────────────

describe('setValue — TEXT', () => {
  it('accepts any string within 5000 chars', async () => {
    stubIssue();
    stubDef(CustomFieldType.TEXT);
    mockFindValue.mockResolvedValue(null);
    mockSaveValue.mockResolvedValue({ value: 'hello' });

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, 'hello')).resolves.toBeDefined();
  });

  it('rejects string over 5000 chars', async () => {
    stubIssue();
    stubDef(CustomFieldType.TEXT);

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, 'x'.repeat(5001))).rejects.toThrow(ValidationError);
  });
});

describe('setValue — NUMBER', () => {
  it.each([['42'], ['3.14'], ['-7'], ['0']])('accepts valid number %s', async (v) => {
    stubIssue();
    stubDef(CustomFieldType.NUMBER);
    mockFindValue.mockResolvedValue(null);
    mockSaveValue.mockResolvedValue({ value: v });

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, v)).resolves.toBeDefined();
  });

  it.each([['abc'], [''], ['12e999'], ['NaN']])('rejects non-finite %s', async (v) => {
    stubIssue();
    stubDef(CustomFieldType.NUMBER);

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, v)).rejects.toThrow(ValidationError);
  });
});

describe('setValue — DROPDOWN', () => {
  it('accepts value in options list', async () => {
    stubIssue();
    stubDef(CustomFieldType.DROPDOWN, ['P0', 'P1', 'P2']);
    mockFindValue.mockResolvedValue(null);
    mockSaveValue.mockResolvedValue({ value: 'P1' });

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, 'P1')).resolves.toBeDefined();
  });

  it('rejects value not in options', async () => {
    stubIssue();
    stubDef(CustomFieldType.DROPDOWN, ['P0', 'P1']);

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, 'P9')).rejects.toThrow(ValidationError);
  });
});

describe('setValue — DATE', () => {
  it.each([['2026-06-11'], ['2026-06-11T14:30:00Z'], ['2026-01-01T00:00:00+05:30']])(
    'accepts valid ISO date %s', async (v) => {
      stubIssue();
      stubDef(CustomFieldType.DATE);
      mockFindValue.mockResolvedValue(null);
      mockSaveValue.mockResolvedValue({ value: v });

      await expect(makeService().setValue(ISSUE_ID, FIELD_ID, v)).resolves.toBeDefined();
    },
  );

  it.each([['11-06-2026'], ['June 11'], ['2026/06/11'], ['not-a-date']])(
    'rejects non-ISO date %s', async (v) => {
      stubIssue();
      stubDef(CustomFieldType.DATE);

      await expect(makeService().setValue(ISSUE_ID, FIELD_ID, v)).rejects.toThrow(ValidationError);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// setValue — cross-project guard
// ─────────────────────────────────────────────────────────────────────────────

describe('setValue — project scoping', () => {
  it('rejects when field belongs to a different project than the issue', async () => {
    mockFindIssueById.mockResolvedValue({ id: ISSUE_ID, projectId: 'project-A' });
    mockFindDefinitionById.mockResolvedValue({
      id: FIELD_ID, projectId: 'project-B', type: CustomFieldType.TEXT,
      options: null, name: 'x', required: false, position: 0,
    });

    await expect(makeService().setValue(ISSUE_ID, FIELD_ID, 'hello')).rejects.toThrow(ForbiddenError);
  });
});
