const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        process: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        NodeJS: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Module 7 Phase 7.5 — the Remotion composition sources import
    // `remotion`/`react` (deploy-only deps, not in this phase's
    // lockfile) and are excluded from the worker's tsc project; they are
    // bundled directly from source by @remotion/bundler on a render
    // deploy. Not part of the lint/typecheck/test matrix.
    ignores: ["dist/**", "node_modules/**", "src/render/remotion/**"],
  },
);
