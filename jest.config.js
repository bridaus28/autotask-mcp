module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  // Source uses NodeNext-style specifiers ('../services/autotask.service.js')
  // which tsc emits verbatim. Jest resolves from .ts, so strip the extension.
  // Without this no test can import tool.handler at all.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transformIgnorePatterns: [
    'node_modules/(?!(autotask-node|@exodus/bytes)/)'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 5,
      functions: 20,
      lines: 10,
      statements: 10
    }
  },
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
}; 