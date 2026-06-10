/**
 * @swagger
 * tags:
 *   - name: Auth
 *     description: Authentication — register, login, logout
 *
 * /api/v1/auth/register:
 *   post:
 *     summary: Register a new user account
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, displayName, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alice@example.com
 *               displayName:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 100
 *                 example: Alice Smith
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: s3cr3tPass!
 *     responses:
 *       201:
 *         description: User registered — returns user + accessToken
 *       400:
 *         description: Validation error (missing/invalid fields)
 *       409:
 *         description: Email already registered
 *
 * /api/v1/auth/login:
 *   post:
 *     summary: Login and obtain a JWT access token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     accessToken:
 *                       type: string
 *                     user:
 *                       type: object
 *       401:
 *         description: Invalid email or password
 */
import Router from '@koa/router';
import { AuthController } from '../../AuthController';
import { validate } from '../../../../core/validation/validate';
import { registerSchema, loginSchema } from '../../schemas/authSchemas';

export const authRouter = new Router({ prefix: '/auth' });

authRouter.post('/register', validate(registerSchema), AuthController.register);
authRouter.post('/login',    validate(loginSchema),    AuthController.login);
