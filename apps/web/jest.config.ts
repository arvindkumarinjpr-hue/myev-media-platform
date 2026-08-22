import nextJest from "next/jest";

const createJestConfig = nextJest({ dir: "./" });

// Module 2 Phase 2.6 — first frontend test setup in this repo. next/jest
// handles the SWC transform (TS/JSX) and CSS/asset mocking with zero extra
// config; jsdom + the RTL setup file are the only additions needed.
const config = {
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // e2e/ holds Playwright specs (run via `pnpm test:e2e:browser`, not
  // Jest) — Jest's own default testMatch also matches *.spec.ts, so
  // without this it would try to run them itself and fail (they import
  // @playwright/test, not Jest's globals, and need a real browser+backend).
  testPathIgnorePatterns: ["<rootDir>/.next/", "<rootDir>/node_modules/", "<rootDir>/e2e/"],
  // Phase 2.7 cleanup: testPathIgnorePatterns alone only excludes test
  // *files* from .next/ — haste-map still scanned every file under it for
  // module naming, tripping over .next/standalone's own copy of
  // package.json ("Haste module naming collision: @myev/web"). This
  // excludes the build output from that scan entirely.
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
};

export default createJestConfig(config);
