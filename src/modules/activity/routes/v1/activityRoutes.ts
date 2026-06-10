/**
 * @swagger
 * tags:
 *   - name: Activity
 *     description: Project activity feed driven by domain events
 *
 * /api/v1/projects/{projectId}/activity:
 *   get:
 *     summary: Paginated activity log for a project (VIEWER+)
 *     tags: [Activity]
 *     description: >
 *       Returns ActivityLog entries created by the domain event pipeline
 *       (IssueCreated, StatusChanged, IssueUpdated, CommentAdded, SprintUpdated).
 *       Supports filtering by actor, entity type, and entity ID.
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
 *         name: entityType
 *         schema:
 *           type: string
 *           enum: [ISSUE, COMMENT, SPRINT, PROJECT]
 *       - in: query
 *         name: entityId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: actorId
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Cursor-paginated activity entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           action:
 *                             type: string
 *                             enum: [CREATED, UPDATED, STATUS_CHANGED, COMMENTED, SPRINT_STARTED, SPRINT_COMPLETED]
 *                           entityType:
 *                             type: string
 *                           entityId:
 *                             type: string
 *                           actorId:
 *                             type: string
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                     nextCursor:
 *                       type: string
 *                       nullable: true
 *                     hasMore:
 *                       type: boolean
 *       403:
 *         description: Not a project member
 */
import Router from '@koa/router';
import { ActivityController } from '../../ActivityController';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { ProjectRole } from '../../../../core/types/enums';

export const activityRouter = new Router();

activityRouter.use(authenticate);

/** GET /api/v1/projects/:projectId/activity — paginated project activity feed */
activityRouter.get('/projects/:projectId/activity', requireProjectRole(ProjectRole.VIEWER), ActivityController.list);
