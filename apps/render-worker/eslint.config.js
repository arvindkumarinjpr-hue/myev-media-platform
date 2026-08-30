const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.json" },
      globals: { process: "readonly", console: "readonly", setInterval: "readonly", clearInterval: "readonly", setTimeout: "readonly", clearTimeout: "readonly", AbortController: "readonly", NodeJS: "readonly" },
    },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  { ignores: ["dist/**", "node_modules/**", "src/render/remotion/**"] },
);
