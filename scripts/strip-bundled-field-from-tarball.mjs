// Rewrites bundled deps in a packed tarball's manifest to file: specifiers.
// The names must stay listed (npm prunes the bundled files otherwise) but
// must not be registry versions (bun tries to fetch those and 404s).
// Note: bundled packages carry their own node_modules, so shared libs load
// as separate instances per package; peer deps would fix that later.
// Usage: bun scripts/strip-bundled-field-from-tarball.mjs <tarball.tgz>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: bun scripts/strip-bundled-field-from-tarball.mjs <tarball.tgz>");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "tarball-fix-"));
execFileSync("tar", ["-xzf", tarball, "-C", work]);

const manifestPath = join(work, "package", "package.json");
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
const bundled = pkg.bundledDependencies ?? pkg.bundleDependencies ?? [];
pkg.dependencies ??= {};
for (const name of bundled) {
  pkg.dependencies[name] = `file:../packages/${name.split("/").pop()}`;
}
pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort());
writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n");

execFileSync("tar", ["-czf", tarball, "-C", work, "package"]);
rmSync(work, { recursive: true, force: true });
console.log(`Rewrote ${bundled.length} bundled deps to file: specifiers in ${tarball}`);
