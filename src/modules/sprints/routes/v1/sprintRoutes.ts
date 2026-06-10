/**
 * @swagger
 * tags:
 *   - name: Sprints
 *     description: Sprint CRUD, lifecycle (start / complete), and velocity tracking
 *
 * /api/v1/projects/{projectId}/sprints:
 *   get:
 *     summary: List sprints for a project (VIEWER+)
 *     tags: [Sprints]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Array of sprints with status (PLANNED | ACTIVE | COMPLETED)
 *   post:
 *     summary: Create a new sprint (PROJECT_LEAD+)
 *     tags: [Sprints]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Sprint 5
 *               goal:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date
 *               endDate:
 *                 type: string
 *                 format: date
 *     responses:
 *       201:
 *         description: Sprint created
 *       400:
 *         description: Validation error
 *       403:
 *         description: Insufficient role
 *
 * /api/v1/sprints/{sprintId}/start:
 *   post:
 *     summary: Start a sprint — acquires advisory lock, transitions to ACTIVE
 *     tags: [Sprints]
 *     parameters:
 *       - in: path
 *         name: sprintId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Sprint started
 *       409:
 *         description: Sprint is not in PLANNED state or another sprint is already active
 *
 * /api/v1/sprints/{sprintId}/complete:
 *   post:
 *     summary: Complete a sprint with optional issue carry-over
 *     tags: [Sprints]
 *     parameters:
 *       - in: path
 *         name: sprintId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               carryOverIssueIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Issues to move to the next sprint (unfinished work)
 *               nextSprintId:
 *                 type: string
 *                 format: uuid
 *                 description: Target sprint for carried-over issues (optional)
 *     responses:
 *       200:
 *         description: Sprint completed — includes computed velocity (story points)
 */
import Router from '@koa/router';
import { SprintController } from '../../SprintController';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { validate } from '../../../../core/validation/validate';
import { createSprintSchema, completeSprintSchema } from '../../schemas/sprintSchemas';
import { ProjectRole } from '../../../../core/types/enums';

export const sprintRouter = new Router();

sprintRouter.use(authenticate);

sprintRouter.get('/projects/:projectId/sprints',      requireProjectRole(ProjectRole.VIEWER), SprintController.list);
sprintRouter.post('/projects/:projectId/sprints',     requireProjectRole(ProjectRole.PROJECT_LEAD), validate(createSprintSchema), SprintController.create);
sprintRouter.post('/sprints/:sprintId/start',         SprintController.start);
sprintRouter.post('/sprints/:sprintId/complete',      validate(completeSprintSchema), SprintController.complete);
