import nextJest from "next/jest";

const createJestConfig = nextJest({ dir: "./" });

// Module 2 Phase 2.6 — first frontend test setup in this repo. next/jest
// handles the SWC transform (TS/JSX) and CSS/asset mocking with zero extra
// config; jsdom + the RTL setup file are the only additions needed.
const config = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testPathIgnorePatterns: ["<rootDir>/.next/", "<rootDir>/node_modules/"],
};

export default createJestConfig(config);
