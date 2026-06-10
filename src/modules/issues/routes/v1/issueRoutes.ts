/**
 * @swagger
 * tags:
 *   - name: Issues
 *     description: Issue CRUD, board view, workflow transitions, watchers
 *
 * /api/v1/projects/{projectId}/issues:
 *   get:
 *     summary: List issues in a project with cursor-based pagination (VIEWER+)
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: sprintId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: backlog
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Cursor-paginated issue list
 *   post:
 *     summary: Create a new issue (MEMBER+)
 *     tags: [Issues]
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
 *             required: [type, title]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [EPIC, STORY, TASK, BUG, SUBTASK]
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [HIGHEST, HIGH, MEDIUM, LOW, LOWEST]
 *                 default: MEDIUM
 *               assigneeId:
 *                 type: string
 *                 format: uuid
 *               parentId:
 *                 type: string
 *                 format: uuid
 *               sprintId:
 *                 type: string
 *                 format: uuid
 *               storyPoints:
 *                 type: integer
 *               labels:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Issue created
 *       400:
 *         description: Validation error
 *
 * /api/v1/projects/{projectId}/board:
 *   get:
 *     summary: Get the board view — columns with issues grouped by status (VIEWER+)
 *     tags: [Issues]
 *     description: >
 *       Results are served from Redis cache (board:project:{id}:sprint:{id}).
 *       Cache is invalidated on any issue mutation.
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: sprintId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Board with columns array; each column has statusId, name, wipLimit, issues
 *
 * /api/v1/issues/{issueId}:
 *   get:
 *     summary: Get a single issue by ID
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Issue details
 *       404:
 *         description: Issue not found
 *   patch:
 *     summary: Update issue fields — requires version for optimistic locking
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: issueId
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
 *             required: [version]
 *             properties:
 *               version:
 *                 type: integer
 *                 description: Current version number — 409 returned on mismatch
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [HIGHEST, HIGH, MEDIUM, LOW, LOWEST]
 *               assigneeId:
 *                 type: string
 *                 format: uuid
 *               sprintId:
 *                 type: string
 *                 format: uuid
 *               storyPoints:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Updated issue
 *       400:
 *         description: Missing version
 *       409:
 *         description: Optimistic lock conflict — version mismatch
 *   delete:
 *     summary: Soft-delete an issue
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *
 * /api/v1/issues/{issueId}/transitions:
 *   post:
 *     summary: Transition an issue to a new workflow status
 *     tags: [Issues]
 *     description: >
 *       Runs ValidationHookRunner (WIP limit, required fields) then AutoActionExecutor.
 *       Returns 422 if a hook blocks the transition.
 *     parameters:
 *       - in: path
 *         name: issueId
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
 *             required: [toStatusId]
 *             properties:
 *               toStatusId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Issue transitioned successfully
 *       422:
 *         description: WIP limit reached or required field missing
 *
 * /api/v1/issues/{issueId}/watchers:
 *   post:
 *     summary: Subscribe the authenticated user as a watcher
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Watcher added
 *   delete:
 *     summary: Unsubscribe the authenticated user from watching
 *     tags: [Issues]
 *     parameters:
 *       - in: path
 *         name: issueId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Watcher removed
 */
import Router from '@koa/router';
import { IssueController } from '../../IssueController';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { validate } from '../../../../core/validation/validate';
import { createIssueSchema, updateIssueSchema } from '../../schemas/issueSchemas';
import { transitionIssueSchema } from '../../../workflow/schemas/workflowSchemas';
import { ProjectRole } from '../../../../core/types/enums';

export const issueRouter = new Router();

issueRouter.use(authenticate);

issueRouter.post('/projects/:projectId/issues',        requireProjectRole(ProjectRole.MEMBER), validate(createIssueSchema), IssueController.create);
issueRouter.get('/projects/:projectId/issues',         requireProjectRole(ProjectRole.VIEWER), IssueController.list);
issueRouter.get('/projects/:projectId/board',          requireProjectRole(ProjectRole.VIEWER), IssueController.getBoard);

issueRouter.get('/issues/:issueId',                    IssueController.get);
issueRouter.patch('/issues/:issueId',                  validate(updateIssueSchema), IssueController.update);
issueRouter.delete('/issues/:issueId',                 IssueController.delete);
issueRouter.post('/issues/:issueId/transitions',       validate(transitionIssueSchema), IssueController.transition);
issueRouter.post('/issues/:issueId/watchers',          IssueController.watch);
issueRouter.delete('/issues/:issueId/watchers',        IssueController.unwatch);
