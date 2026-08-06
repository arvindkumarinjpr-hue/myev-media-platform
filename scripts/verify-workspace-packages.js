#!/usr/bin/env node
"use strict";

/**
 * Packaging validation only — not an architecture, queue, worker, or API
 * check. Resolves and loads reflect-metadata from each package's own
 * dependency tree before requiring it, mirroring every real consumer's own
 * entrypoint (apps/api/src/main.ts, apps/worker/src/main.ts) — a package
 * whose exports carry class-validator decorators (e.g. @myev/shared's
 * ProcessorManifest payload DTOs) throws at module-evaluation time without
 * it already polyfilled, and it is not necessarily hoisted to this script's
 * own module scope.
 *
 * For every workspace package under packages/* that declares a `main`
 * entrypoint (i.e., is meant to be require()'d by another workspace member —
 * apps/* are terminal deployables with no `main` field and are correctly
 * out of scope here), this:
 *   1. confirms the declared `main` (and `types`, if present) file actually
 *      exists on disk after the build step,
 *   2. resolves and require()s the package by NAME through Node's real
 *      module resolution (node_modules symlink -> package.json fields ->
 *      compiled file) — exactly how any other workspace member consumes
 *      it, not by reading the file directly,
 *   3. confirms the loaded module is non-empty.
 *
 * This exists because packages/shared's `main`/`types` pointed at raw .ts
 * source for the entire Module 1A-1E lifetime without anyone noticing:
 * every consumer only ever did `import type` from it (fully erased at
 * compile time), so nothing ever actually required() it until Module 1F.
 * A real runtime import check like this one would have failed loudly the
 * moment that misconfiguration was introduced, instead of surfacing months
 * later as a container crash.
 */

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const workspaceGlobs = ["apps", "packages"];

function listWorkspaceMemberDirs() {
  const dirs = [];
  for (const group of workspaceGlobs) {
    const groupDir = path.join(repoRoot, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(groupDir, entry.name);
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

// A real consumer's node_modules symlink for an internal package lives
// inside THAT CONSUMER's own directory (e.g. apps/worker/node_modules/@myev/shared),
// not necessarily at the repo root — pnpm only symlinks a dependency into
// whichever workspace member's own package.json actually declares it.
// Trying every workspace member's directory as a resolution root mirrors
// how each of them would really consume the package.
const workspaceMemberDirs = listWorkspaceMemberDirs();
const resolutionPaths = [repoRoot, ...workspaceMemberDirs];

const packagesDir = path.join(repoRoot, "packages");

function findInternalPackages() {
  if (!fs.existsSync(packagesDir)) return [];

  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    // Only packages declaring `main` are meant to be require()'d by
    // another workspace member — that is the exact contract this script
    // verifies.
    if (!pkgJson.main) continue;

    packages.push({ dir, pkgJson });
  }

  return packages;
}

function verifyPackage({ dir, pkgJson }) {
  const errors = [];
  const name = pkgJson.name;

  const mainPath = path.resolve(dir, pkgJson.main);
  if (!fs.existsSync(mainPath)) {
    errors.push(`main entrypoint "${pkgJson.main}" does not exist on disk (${mainPath}) — was the package built?`);
  }

  if (pkgJson.types) {
    const typesPath = path.resolve(dir, pkgJson.types);
    if (!fs.existsSync(typesPath)) {
      errors.push(`types entrypoint "${pkgJson.types}" does not exist on disk (${typesPath})`);
    }
  }

  // A missing file makes the require() below fail for the same reason,
  // less clearly — stop here once it's already been reported precisely.
  if (errors.length > 0) return errors;

  // Best-effort: if this package's own dependency tree carries
  // reflect-metadata, load it first (see the file header comment). Not
  // every internal package needs it, so a resolution failure here is
  // silently ignored — the package's own require() below will surface
  // the real error if it actually did need it.
  try {
    require(require.resolve("reflect-metadata", { paths: [dir, ...resolutionPaths] }));
  } catch {
    // Not needed by this package — fine.
  }

  let mod;
  try {
    const resolved = require.resolve(name, { paths: resolutionPaths });
    mod = require(resolved);
  } catch (error) {
    errors.push(`runtime require("${name}") failed: ${error instanceof Error ? error.message : String(error)}`);
    return errors;
  }

  if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) {
    errors.push(`require("${name}") resolved to a non-module value (typeof ${typeof mod})`);
    return errors;
  }

  if (Object.keys(mod).length === 0) {
    errors.push(`require("${name}") resolved to a module with no exports`);
  }

  return errors;
}

function main() {
  const packages = findInternalPackages();

  if (packages.length === 0) {
    console.log("No internal workspace package under packages/* declares a `main` entrypoint — nothing to verify.");
    return;
  }

  let failed = false;
  for (const pkg of packages) {
    const errors = verifyPackage(pkg);
    if (errors.length === 0) {
      console.log(`PASS ${pkg.pkgJson.name}`);
    } else {
      failed = true;
      console.error(`FAIL ${pkg.pkgJson.name}`);
      for (const error of errors) console.error(`  - ${error}`);
    }
  }

  if (failed) {
    console.error("\nOne or more internal workspace packages failed runtime import verification.");
    process.exit(1);
  }

  console.log(`\nAll ${packages.length} internal workspace package(s) import cleanly at runtime.`);
}

main();
