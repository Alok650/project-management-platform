import { Context } from 'koa';
import { CustomFieldService } from './CustomFieldService';
import { CustomFieldRepository } from './CustomFieldRepository';
import { IssueRepository } from '../issues/IssueRepository';
import { ok } from '../../core/types/ApiResponse';
import { CustomFieldType } from '../../core/types/enums';

const service = new CustomFieldService(new CustomFieldRepository(), new IssueRepository());

/** HTTP handler layer for custom field definition and value endpoints */
export class CustomFieldController {
  // ── Definitions ────────────────────────────────────────────────────────────

  static async listDefinitions(ctx: Context): Promise<void> {
    ctx.body = ok(await service.listDefinitions(ctx.params['projectId']!));
  }

  static async createDefinition(ctx: Context): Promise<void> {
    const body = ctx.request.body as {
      name: string; type: CustomFieldType; options?: string[]; required?: boolean; position?: number;
    };
    const def = await service.createDefinition(ctx.params['projectId']!, body);
    ctx.status = 201;
    ctx.body = ok(def);
  }

  static async updateDefinition(ctx: Context): Promise<void> {
    const body = ctx.request.body as { name?: string; options?: string[]; required?: boolean; position?: number };
    ctx.body = ok(await service.updateDefinition(ctx.params['fieldId']!, ctx.params['projectId']!, body));
  }

  static async deleteDefinition(ctx: Context): Promise<void> {
    await service.deleteDefinition(ctx.params['fieldId']!, ctx.params['projectId']!);
    ctx.status = 204;
  }

  // ── Values ─────────────────────────────────────────────────────────────────

  static async listValues(ctx: Context): Promise<void> {
    ctx.body = ok(await service.listValues(ctx.params['issueId']!));
  }

  static async setValue(ctx: Context): Promise<void> {
    const { value } = ctx.request.body as { value: string };
    const result = await service.setValue(ctx.params['issueId']!, ctx.params['fieldDefinitionId']!, value);
    ctx.status = 200;
    ctx.body = ok(result);
  }

  static async clearValue(ctx: Context): Promise<void> {
    await service.clearValue(ctx.params['issueId']!, ctx.params['fieldDefinitionId']!);
    ctx.status = 204;
  }
}
