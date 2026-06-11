import { AppDataSource } from '../../config/database';
import { CustomFieldDefinition } from '../../models/CustomFieldDefinition';
import { CustomFieldValue } from '../../models/CustomFieldValue';

/** Data access for custom field definitions and values */
export class CustomFieldRepository {
  private readonly defRepo   = AppDataSource.getRepository(CustomFieldDefinition);
  private readonly valueRepo = AppDataSource.getRepository(CustomFieldValue);

  // ── Definitions ────────────────────────────────────────────────────────────

  findDefinitionById(id: string): Promise<CustomFieldDefinition | null> {
    return this.defRepo.findOne({ where: { id } });
  }

  listDefinitions(projectId: string): Promise<CustomFieldDefinition[]> {
    return this.defRepo.find({ where: { projectId }, order: { position: 'ASC', createdAt: 'ASC' } });
  }

  saveDefinition(def: Partial<CustomFieldDefinition>): Promise<CustomFieldDefinition> {
    return this.defRepo.save(def);
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.defRepo.delete({ id });
  }

  // ── Values ─────────────────────────────────────────────────────────────────

  listValues(issueId: string): Promise<CustomFieldValue[]> {
    return this.valueRepo.find({ where: { issueId }, relations: ['fieldDefinition'] });
  }

  findValue(fieldDefinitionId: string, issueId: string): Promise<CustomFieldValue | null> {
    return this.valueRepo.findOne({ where: { fieldDefinitionId, issueId } });
  }

  saveValue(value: Partial<CustomFieldValue>): Promise<CustomFieldValue> {
    return this.valueRepo.save(value);
  }

  async deleteValue(fieldDefinitionId: string, issueId: string): Promise<void> {
    await this.valueRepo.delete({ fieldDefinitionId, issueId });
  }
}
