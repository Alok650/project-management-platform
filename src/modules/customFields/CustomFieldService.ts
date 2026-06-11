import { CustomFieldRepository } from './CustomFieldRepository';
import { IssueRepository } from '../issues/IssueRepository';
import { NotFoundError, ValidationError, ForbiddenError } from '../../core/errors/errors';
import { CustomFieldType } from '../../core/types/enums';
import type { CustomFieldDefinition } from '../../models/CustomFieldDefinition';
import type { CustomFieldValue } from '../../models/CustomFieldValue';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Business logic for custom field definitions and per-issue values */
export class CustomFieldService {
  constructor(
    private readonly repo:      CustomFieldRepository,
    private readonly issueRepo: IssueRepository,
  ) {}

  // ── Definitions ────────────────────────────────────────────────────────────

  listDefinitions(projectId: string): Promise<CustomFieldDefinition[]> {
    return this.repo.listDefinitions(projectId);
  }

  async createDefinition(
    projectId: string,
    data: { name: string; type: CustomFieldType; options?: string[] | null; required?: boolean; position?: number },
  ): Promise<CustomFieldDefinition> {
    if (data.type === CustomFieldType.DROPDOWN && (!data.options || data.options.length === 0)) {
      throw new ValidationError('Validation failed', { options: 'DROPDOWN fields require at least one option' });
    }
    return this.repo.saveDefinition({
      projectId,
      name:     data.name,
      type:     data.type,
      options:  data.type === CustomFieldType.DROPDOWN ? (data.options ?? null) : null,
      required: data.required ?? false,
      position: data.position ?? 0,
    });
  }

  async updateDefinition(
    fieldId: string,
    projectId: string,
    data: { name?: string; options?: string[] | null; required?: boolean; position?: number },
  ): Promise<CustomFieldDefinition> {
    const def = await this.repo.findDefinitionById(fieldId);
    if (!def) throw new NotFoundError('CustomFieldDefinition', fieldId);
    if (def.projectId !== projectId) throw new ForbiddenError('modify', 'this field');

    if (def.type === CustomFieldType.DROPDOWN && data.options !== undefined && data.options !== null && data.options.length === 0) {
      throw new ValidationError('Validation failed', { options: 'DROPDOWN fields require at least one option' });
    }

    return this.repo.saveDefinition({ ...def, ...data });
  }

  async deleteDefinition(fieldId: string, projectId: string): Promise<void> {
    const def = await this.repo.findDefinitionById(fieldId);
    if (!def) throw new NotFoundError('CustomFieldDefinition', fieldId);
    if (def.projectId !== projectId) throw new ForbiddenError('delete', 'this field');
    await this.repo.deleteDefinition(fieldId);
  }

  // ── Values ─────────────────────────────────────────────────────────────────

  async listValues(issueId: string): Promise<CustomFieldValue[]> {
    const issue = await this.issueRepo.findById(issueId);
    if (!issue) throw new NotFoundError('Issue', issueId);
    return this.repo.listValues(issueId);
  }

  async setValue(issueId: string, fieldDefinitionId: string, rawValue: string): Promise<CustomFieldValue> {
    const [issue, def] = await Promise.all([
      this.issueRepo.findById(issueId),
      this.repo.findDefinitionById(fieldDefinitionId),
    ]);
    if (!issue) throw new NotFoundError('Issue', issueId);
    if (!def)   throw new NotFoundError('CustomFieldDefinition', fieldDefinitionId);

    // Field must belong to the issue's project
    if (def.projectId !== issue.projectId) {
      throw new ForbiddenError('set', 'a field from a different project');
    }

    this.assertValidValue(def, rawValue);

    const existing = await this.repo.findValue(fieldDefinitionId, issueId);
    return this.repo.saveValue({ ...(existing ?? {}), fieldDefinitionId, issueId, value: rawValue });
  }

  async clearValue(issueId: string, fieldDefinitionId: string): Promise<void> {
    const issue = await this.issueRepo.findById(issueId);
    if (!issue) throw new NotFoundError('Issue', issueId);
    await this.repo.deleteValue(fieldDefinitionId, issueId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertValidValue(def: CustomFieldDefinition, value: string): void {
    switch (def.type) {
      case CustomFieldType.NUMBER:
        if (value.trim() === '' || !Number.isFinite(Number(value))) {
          throw new ValidationError('Validation failed', { value: 'Must be a valid number' });
        }
        break;
      case CustomFieldType.DROPDOWN:
        if (!def.options?.includes(value)) {
          throw new ValidationError('Validation failed', { value: `Must be one of: ${def.options?.join(', ')}` });
        }
        break;
      case CustomFieldType.DATE:
        if (!ISO_DATE_RE.test(value)) {
          throw new ValidationError('Validation failed', { value: 'Must be an ISO 8601 date (e.g. 2026-06-11)' });
        }
        break;
      case CustomFieldType.TEXT:
        if (value.length > 5000) {
          throw new ValidationError('Validation failed', { value: 'Text fields may not exceed 5000 characters' });
        }
        break;
    }
  }
}
