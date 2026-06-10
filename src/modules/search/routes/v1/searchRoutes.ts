/**
 * @swagger
 * tags:
 *   - name: Search
 *     description: Full-text search across issues and comments (MySQL FULLTEXT)
 *
 * /api/v1/projects/{projectId}/search:
 *   get:
 *     summary: Full-text search for issues or comments within a project
 *     tags: [Search]
 *     description: >
 *       Uses MySQL FULLTEXT indexes (MATCH...AGAINST NATURAL LANGUAGE MODE).
 *       Minimum query length is 2 characters.
 *       Add `type=COMMENT` to search comment content instead of issue titles/descriptions.
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search query (minimum 2 characters)
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [ISSUE, COMMENT]
 *           default: ISSUE
 *       - in: query
 *         name: statusId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: assigneeId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: issueType
 *         schema:
 *           type: string
 *           enum: [EPIC, STORY, TASK, BUG, SUBTASK]
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *     responses:
 *       200:
 *         description: Cursor-paginated search results with relevance scores
 *       400:
 *         description: Query missing or shorter than minimum length
 *       403:
 *         description: Not a project member
 */
import Router from '@koa/router';
import { SearchController } from '../../SearchController';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { ProjectRole } from '../../../../core/types/enums';

export const searchRouter = new Router();

searchRouter.use(authenticate);

/** GET /api/v1/projects/:projectId/search — FULLTEXT search for issues and comments */
searchRouter.get('/projects/:projectId/search', requireProjectRole(ProjectRole.VIEWER), SearchController.search);
