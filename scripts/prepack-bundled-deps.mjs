/**
 * Materializes bundled `file:` dependencies before `npm pack` / `npm publish`.
 *
 * Bun resolves `file:../` dependencies by creating directories whose files
 * are symlinks back to the source package. `npm pack` does not follow these
 * symlinks, so the published tarball ends up without the bundled packages.
 *
 * This script replaces each symlink-based directory in `node_modules/` with
 * a real copy of the source package, so `npm pack` includes them correctly.
 *
 * Usage (from a package directory):
 *   node ../scripts/prepack-bundled-deps.mjs
 */

import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = process.cwd();
const pkgPath = join(pkgDir, "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const deps = pkg.dependencies ?? {};
const bundled = new Set(pkg.bundledDependencies ?? []);

const unbundled = Object.entries(deps)
  .filter(([, specifier]) => specifier.startsWith("file:"))
  .filter(([name]) => !bundled.has(name));

if (unbundled.length > 0) {
  for (const [name, specifier] of unbundled) {
    console.error(`"${name}" uses a file: specifier (${specifier}) but is not in bundledDependencies.`);
  }
  console.error("\nAdd these packages to bundledDependencies so they are included in the npm tarball.");
  process.exit(1);
}

let materialized = 0;

for (const [name, specifier] of Object.entries(deps)) {
  if (!specifier.startsWith("file:")) {
    continue;
  }

  const sourcePath = resolve(pkgDir, specifier.replace("file:", ""));
  const nmPath = join(pkgDir, "node_modules", ...name.split("/"));

  if (!existsSync(sourcePath)) {
    console.error(`Source path does not exist: ${sourcePath}`);
    process.exit(1);
  }

  if (!existsSync(nmPath)) {
    console.error(`node_modules path does not exist: ${nmPath} — run install first`);
    process.exit(1);
  }

  // Check if materialization is needed by looking for symlinks inside
  const entries = readdirSync(nmPath);
  const hasSymlinks = entries.some((entry) =>
    lstatSync(join(nmPath, entry)).isSymbolicLink(),
  );

  if (!hasSymlinks) {
    continue;
  }

  console.log(`Materializing ${name} from ${sourcePath}`);
  rmSync(nmPath, { recursive: true, force: true });
  cpSync(sourcePath, nmPath, {
    recursive: true,
    filter: (src) => !src.includes("/node_modules/") && !src.endsWith("/node_modules"),
  });
  materialized++;
}

if (materialized > 0) {
  console.log(`Materialized ${materialized} bundled dependency package(s).`);
} else {
  console.log("All bundled dependencies already materialized.");
}
