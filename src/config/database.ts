import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from './env';
import * as models from '../models';

/**
 * Singleton TypeORM DataSource.
 * Call `AppDataSource.initialize()` once in server.ts at startup.
 */
export const AppDataSource = new DataSource({
  type: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  synchronize: false,
  logging: env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
  entities: Object.values(models),
  migrations: [process.env.NODE_ENV === 'production' ? 'dist/migrations/*.js' : 'src/migrations/*.ts'],
  extra: {
    connectionLimit: env.DB_POOL_MAX,
    acquireTimeout: 30_000,
    waitForConnections: true,
  },
});
