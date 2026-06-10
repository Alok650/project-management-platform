import Joi from 'joi';

/** Validated, typed representation of all required environment variables. */
export interface Env {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly PORT: number;
  readonly DB_HOST: string;
  readonly DB_PORT: number;
readonly DB_NAME: string;
  readonly DB_USER: string;
  readonly DB_PASSWORD: string;
  readonly DB_POOL_MAX: number;
  readonly REDIS_URL: string;
  readonly JWT_SECRET: string;
  readonly JWT_EXPIRES_IN: string;
  readonly AWS_REGION: string;
  readonly AWS_ENDPOINT?: string;
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
  readonly SQS_NOTIFICATION_QUEUE_URL: string;
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

const schema = Joi.object<Env>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(3306),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_POOL_MAX: Joi.number().default(50),
  REDIS_URL: Joi.string().required(),
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_ENDPOINT: Joi.string().uri().optional(),
  AWS_ACCESS_KEY_ID: Joi.string().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  SQS_NOTIFICATION_QUEUE_URL: Joi.string().required(),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),
}).unknown(true);

const { error, value } = schema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

/**
 * Validated environment configuration.
 * Throws at module load time if any required variable is missing or invalid.
 */
export const env = value as Env;
