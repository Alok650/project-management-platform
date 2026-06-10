/**
 * @swagger
 * tags:
 *   - name: Comments
 *     description: Threaded comments with @mention parsing
 *
 * /api/v1/issues/{issueId}/comments:
 *   get:
 *     summary: List comments on an issue (cursor-paginated, top-level with replies)
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: issueId
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
 *     responses:
 *       200:
 *         description: Paginated comments with parsed mentions array
 *   post:
 *     summary: Create a comment or reply (@mentions are parsed automatically)
 *     tags: [Comments]
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
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 maxLength: 50000
 *                 example: Great catch @alice! Fixed in this PR.
 *               parentId:
 *                 type: string
 *                 format: uuid
 *                 description: Set to reply to an existing comment
 *     responses:
 *       201:
 *         description: Comment created; CommentAdded event dispatched for notifications
 *       400:
 *         description: Validation error (content required, parentId must be valid UUID)
 *
 * /api/v1/comments/{commentId}:
 *   patch:
 *     summary: Update comment content (original author only)
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: commentId
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
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated comment
 *       403:
 *         description: Not the comment author
 *       404:
 *         description: Comment not found
 *   delete:
 *     summary: Soft-delete a comment (original author only)
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *       403:
 *         description: Not the comment author
 */
import Router from '@koa/router';
import { CommentController } from '../../CommentController';
import { authenticate } from '../../../../core/middleware/auth';
import { validate } from '../../../../core/validation/validate';
import { createCommentSchema, updateCommentSchema } from '../../schemas/commentSchemas';

export const commentRouter = new Router();

commentRouter.use(authenticate);

commentRouter.get('/issues/:issueId/comments',   CommentController.list);
commentRouter.post('/issues/:issueId/comments',  validate(createCommentSchema), CommentController.create);
commentRouter.patch('/comments/:commentId',      validate(updateCommentSchema), CommentController.update);
commentRouter.delete('/comments/:commentId',     CommentController.delete);
