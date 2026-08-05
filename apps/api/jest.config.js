/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    // .ts only — the generated Prisma client (apps/api/generated/prisma) is
    // already-compiled JS and must run as-is, not be re-processed by ts-jest.
    "^.+\\.ts$": "ts-jest",
  },
  collectCoverageFrom: ["src/**/*.(t|j)s"],
  coverageDirectory: "./coverage",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@myev/shared$": "<rootDir>/../../packages/shared/src/index.ts",
  },
};
