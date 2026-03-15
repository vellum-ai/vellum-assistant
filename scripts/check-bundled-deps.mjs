/**
 * Validates that every `file:` dependency in a package.json is listed in
 * `bundledDependencies`. This prevents broken installs when the package
 * is published to npm and installed globally (e.g. via `bun install -g vellum`),
 * where the relative `file:../` paths no longer exist.
 *
 * Usage:
 *   node scripts/check-bundled-deps.mjs <dir> [<dir> ...]
 *
 * Each <dir> should be a package directory containing a package.json.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function checkPackage(dir) {
  const pkgPath = join(resolve(dir), "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to read ${pkgPath}: ${err.message}`);
    return 1;
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const fileDeps = Object.keys(allDeps).filter((name) =>
    allDeps[name].startsWith("file:"),
  );

  if (fileDeps.length === 0) {
    return 0;
  }

  const bundled = new Set(pkg.bundledDependencies ?? []);
  const errors = [];

  for (const dep of fileDeps) {
    if (!bundled.has(dep)) {
      errors.push(
        `"${dep}" uses a file: specifier (${allDeps[dep]}) but is not listed in bundledDependencies.`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`\n${pkg.name ?? pkgPath}:`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error(
      "\nAdd these packages to bundledDependencies so they are included in the npm tarball.",
    );
  }

  return errors.length;
}

// --- Main ---

const dirs = process.argv.slice(2);

if (dirs.length === 0) {
  console.error("Usage: node scripts/check-bundled-deps.mjs <dir> [<dir> ...]");
  process.exit(1);
}

let totalErrors = 0;

for (const dir of dirs) {
  totalErrors += checkPackage(dir);
}

if (totalErrors > 0) {
  console.error(`\nFound ${totalErrors} file: dependency problem(s).`);
  process.exit(1);
} else {
  console.log(
    `Validated ${dirs.length} package(s) — all file: dependencies are properly bundled.`,
  );
}
