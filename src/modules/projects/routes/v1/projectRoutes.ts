/**
 * @swagger
 * tags:
 *   - name: Projects
 *     description: Project CRUD and membership management
 *
 * /api/v1/projects:
 *   get:
 *     summary: List projects the authenticated user belongs to
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: Array of projects
 *   post:
 *     summary: Create a new project
 *     tags: [Projects]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, key]
 *             properties:
 *               name:
 *                 type: string
 *                 example: My Project
 *               key:
 *                 type: string
 *                 example: MYPROJ
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Project created
 *       400:
 *         description: Validation error
 *
 * /api/v1/projects/{projectId}:
 *   get:
 *     summary: Get a single project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Project details
 *       403:
 *         description: Not a member
 *       404:
 *         description: Not found
 *   patch:
 *     summary: Update project metadata (PROJECT_LEAD+)
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated project
 *       403:
 *         description: Insufficient role
 *   delete:
 *     summary: Soft-delete a project (ADMIN only)
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *       403:
 *         description: Not an admin
 *
 * /api/v1/projects/{projectId}/members:
 *   get:
 *     summary: List project members (VIEWER+)
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Array of memberships
 *   post:
 *     summary: Add a member to the project (ADMIN only)
 *     tags: [Projects]
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
 *             required: [userId, role]
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *               role:
 *                 type: string
 *                 enum: [ADMIN, PROJECT_LEAD, MEMBER, VIEWER]
 *     responses:
 *       201:
 *         description: Member added
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not an admin
 *
 * /api/v1/projects/{projectId}/members/{userId}:
 *   delete:
 *     summary: Remove a member from the project (ADMIN only)
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Member removed
 */
import Router from '@koa/router';
import { ProjectController } from '../../ProjectController';
import { authenticate } from '../../../../core/middleware/auth';
import { requireProjectRole } from '../../../../core/middleware/rbac';
import { validate } from '../../../../core/validation/validate';
import { createProjectSchema, updateProjectSchema, addMemberSchema } from '../../schemas/projectSchemas';
import { ProjectRole } from '../../../../core/types/enums';

export const projectRouter = new Router({ prefix: '/projects' });

projectRouter.use(authenticate);

projectRouter.post('/',                             validate(createProjectSchema),                          ProjectController.create);
projectRouter.get('/',                                                                                      ProjectController.list);
projectRouter.get('/:projectId',                    requireProjectRole(ProjectRole.VIEWER),                ProjectController.get);
projectRouter.patch('/:projectId',                  requireProjectRole(ProjectRole.PROJECT_LEAD), validate(updateProjectSchema), ProjectController.update);
projectRouter.delete('/:projectId',                 requireProjectRole(ProjectRole.ADMIN),                 ProjectController.delete);
projectRouter.get('/:projectId/members',            requireProjectRole(ProjectRole.VIEWER),                ProjectController.listMembers);
projectRouter.post('/:projectId/members',           requireProjectRole(ProjectRole.ADMIN), validate(addMemberSchema), ProjectController.addMember);
projectRouter.delete('/:projectId/members/:userId', requireProjectRole(ProjectRole.ADMIN),                ProjectController.removeMember);
