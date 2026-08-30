/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "..",
  testMatch: ["<rootDir>/test/**/*.smoke-spec.ts"],
  transform: { "^.+\\.ts$": "ts-jest" },
  testEnvironment: "node",
  testTimeout: 300000,
  maxWorkers: 1,
};
