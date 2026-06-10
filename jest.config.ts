import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // p-limit v6 and yocto-queue are pure-ESM packages — map p-limit to a CJS-safe stub
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^p-limit$': '<rootDir>/tests/__mocks__/p-limit.js',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.ts', '!src/migrations/**', '!src/seeds/**'],
};
export default config;
