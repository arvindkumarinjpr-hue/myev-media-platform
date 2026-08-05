/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "..",
  testRegex: ".e2e-spec\\.ts$",
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  testEnvironment: "node",
  testTimeout: 30000,
  // Module 1C adds e2e files that share mutable, uniqueness-constrained
  // global state across the same Postgres database (the single Platform
  // Owner, the RBAC catalog) — serial, single-worker execution is required
  // so two files' setup/teardown can never interleave.
  maxWorkers: 1,
  moduleNameMapper: {
    "^@myev/shared$": "<rootDir>/../../packages/shared/src/index.ts",
  },
};
