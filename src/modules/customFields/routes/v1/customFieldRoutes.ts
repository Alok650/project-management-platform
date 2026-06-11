/**
 * @swagger
 * tags:
 *   - name: CustomFields
 *     description: Project-scoped custom field definitions and per-issue values
 *
 * /api/v1/projects/{projectId}/custom-fields:
 *   get:
 *     summary: List custom field definitions for a project (VIEWER+)
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Array of field definitions ordered by position
 *   post:
 *     summary: Create a custom field definition (PROJECT_LEAD+)
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, type]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Story points
 *               type:
 *                 type: string
 *                 enum: [TEXT, NUMBER, DROPDOWN, DATE]
 *               options:
 *                 type: array
 *                 items: { type: string }
 *                 description: Required when type is DROPDOWN
 *               required:
 *                 type: boolean
 *                 default: false
 *               position:
 *                 type: integer
 *                 default: 0
 *     responses:
 *       201:
 *         description: Field definition created
 *       400:
 *         description: Validation error
 *
 * /api/v1/projects/{projectId}/custom-fields/{fieldId}:
 *   patch:
 *     summary: Update a custom field definition (PROJECT_LEAD+)
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fieldId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               options:
 *                 type: array
 *                 items: { type: string }
 *               required: { type: boolean }
 *               position: { type: integer }
 *     responses:
 *       200:
 *         description: Updated definition
 *       403:
 *         description: Field belongs to a different project
 *       404:
 *         description: Field not found
 *   delete:
 *     summary: Delete a custom field definition and all its values (PROJECT_LEAD+)
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fieldId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Field not found
 *
 * /api/v1/issues/{issueId}/fields:
 *   get:
 *     summary: List all custom field values set on an issue
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Array of values with their definitions embedded
 *       404:
 *         description: Issue not found
 *
 * /api/v1/issues/{issueId}/fields/{fieldDefinitionId}:
 *   put:
 *     summary: Set (upsert) a custom field value on an issue
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fieldDefinitionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [value]
 *             properties:
 *               value:
 *                 type: string
 *                 example: "42"
 *     responses:
 *       200:
 *         description: Value set
 *       400:
 *         description: Value fails type validation
 *       404:
 *         description: Issue or field definition not found
 *   delete:
 *     summary: Clear a custom field value from an issue
 *     tags: [CustomFields]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: fieldDefinitionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Cleared
 */
import Router from '@koa/router';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { validate } from '../../../../core/validation/validate';
import { ProjectRole } from '../../../../core/types/enums';
import { CustomFieldController } from '../../CustomFieldController';
import {
  createDefinitionSchema,
  updateDefinitionSchema,
  setValueSchema,
} from '../../schemas/customFieldSchemas';

export const customFieldRouter = new Router();

customFieldRouter.use(authenticate);

// ── Field definitions (project-scoped) ────────────────────────────────────────
customFieldRouter.get(
  '/projects/:projectId/custom-fields',
  requireProjectRole(ProjectRole.VIEWER),
  CustomFieldController.listDefinitions,
);
customFieldRouter.post(
  '/projects/:projectId/custom-fields',
  requireProjectRole(ProjectRole.PROJECT_LEAD),
  validate(createDefinitionSchema),
  CustomFieldController.createDefinition,
);
customFieldRouter.patch(
  '/projects/:projectId/custom-fields/:fieldId',
  requireProjectRole(ProjectRole.PROJECT_LEAD),
  validate(updateDefinitionSchema),
  CustomFieldController.updateDefinition,
);
customFieldRouter.delete(
  '/projects/:projectId/custom-fields/:fieldId',
  requireProjectRole(ProjectRole.PROJECT_LEAD),
  CustomFieldController.deleteDefinition,
);

// ── Field values (issue-scoped) ────────────────────────────────────────────────
customFieldRouter.get('/issues/:issueId/fields', CustomFieldController.listValues);
customFieldRouter.put(
  '/issues/:issueId/fields/:fieldDefinitionId',
  validate(setValueSchema),
  CustomFieldController.setValue,
);
customFieldRouter.delete('/issues/:issueId/fields/:fieldDefinitionId', CustomFieldController.clearValue);
