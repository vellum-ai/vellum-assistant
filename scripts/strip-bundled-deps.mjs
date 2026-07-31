// Workspace/file deps ship inside the tarball via bundledDependencies and
// are never published to npm. Bun's installer still tries to fetch them
// from the registry, so remove the entries before packing.
// Usage: bun scripts/strip-bundled-deps.mjs <package-dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error("usage: bun scripts/strip-bundled-deps.mjs <package-dir>");
  process.exit(1);
}

const manifestPath = join(pkgDir, "package.json");
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
const bundled = new Set(pkg.bundledDependencies ?? pkg.bundleDependencies ?? []);
const deps = pkg.dependencies ?? {};

const local = Object.entries(deps).filter(
  ([, spec]) => spec.startsWith("workspace:") || spec.startsWith("file:"),
);
const unbundled = local.filter(([name]) => !bundled.has(name));
if (unbundled.length > 0) {
  for (const [name, spec] of unbundled) {
    console.error(`"${name}" (${spec}) is not in bundledDependencies — the published package would be unresolvable.`);
  }
  process.exit(1);
}

for (const [name] of local) {
  delete deps[name];
}

if (local.length === 0) {
  console.log(`No workspace/file entries in ${manifestPath} dependencies; nothing to strip.`);
} else {
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`Stripped from ${manifestPath} dependencies: ${local.map(([n]) => n).join(", ")}`);
}
