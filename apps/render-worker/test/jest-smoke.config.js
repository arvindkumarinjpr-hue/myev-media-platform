/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts", "tsx"],
  rootDir: "..",
  testMatch: ["<rootDir>/test/**/*.smoke-spec.ts"],
  transform: { "^.+\\.(t|j)sx?$": "ts-jest" },
  testEnvironment: "node",
  testTimeout: 300000,
  maxWorkers: 1,
};
