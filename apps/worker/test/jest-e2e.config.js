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
  // Each e2e-spec file boots its own full AppModule — including its own
  // real BullMqWorkerManager, which opens its own BullMQ Worker on the
  // same "SYSTEM" queue. Running spec files in parallel (Jest's default)
  // would put multiple independent Worker instances competing as
  // consumers on that one shared queue — the same class of race
  // discovered (and fixed by ordering, not by mocking) with the live
  // Docker Compose worker container during local verification.
  maxWorkers: 1,
  // DIAG ONLY — Module 1F Phase A CI forensics. Revert before merge.
  reporters: ["default", "<rootDir>/test/diag-timeline-reporter.js"],
};
