#!/usr/bin/env bun
/**
 * Install the transitive `file:` dependencies of this package.
 *
 * The repo intentionally uses per-package `bun install` with no
 * workspaces (see `clients/AGENTS.md`). A `file:` dependency is linked as a
 * symlink, but `bun install` does not descend into it — the linked
 * package's own directory gets no `node_modules`, so *its* `file:` deps
 * (`@vellumai/local-mode` → `@vellumai/environments`) are never linked.
 * Nothing fails at install time; it surfaces later as a Vite/Rollup
 * "failed to resolve <pkg>" the moment the dev server loads a config
 * that imports a plugin pulling in the unlinked package.
 *
 * Run from `postinstall` so every install path that touches this app —
 * `dev`, `dev:standalone`, `dev:electron-only`, or a bare `bun install`
 * — converges on a working tree, the same way `clients/web`'s postinstall
 * bootstraps its cross-package setup. The walk installs each transitive
 * `file:` dependency deepest-first and excludes this package itself, so
 * it can't re-enter the `bun install` that triggered it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const FILE_PREFIX = "file:";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");

function fileDepDirs(pkgDir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(pkgDir, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const specs = Object.values({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  return specs
    .filter((spec) => spec.startsWith(FILE_PREFIX))
    .map((spec) => path.resolve(pkgDir, spec.slice(FILE_PREFIX.length)));
}

// Depth-first post-order walk so a package is emitted only after every
// `file:` dependency it transitively needs. `visiting` guards against a
// cycle hanging the walk; `done` dedupes a package shared by two paths.
// The starting package is intentionally excluded from `ordered` — its
// own `bun install` is already in flight.
const ordered: string[] = [];
const done = new Set<string>();
const visiting = new Set<string>();

function visit(pkgDir: string, isRoot: boolean): void {
  if (done.has(pkgDir)) return;
  if (visiting.has(pkgDir)) {
    throw new Error(`Cyclic file: dependency detected at ${pkgDir}`);
  }
  visiting.add(pkgDir);
  for (const dep of fileDepDirs(pkgDir)) visit(dep, false);
  visiting.delete(pkgDir);
  done.add(pkgDir);
  if (!isRoot) ordered.push(pkgDir);
}

visit(packageRoot, true);

for (const pkgDir of ordered) {
  const label = path.relative(repoRoot, pkgDir);
  console.log(`[install-file-deps] bun install (${label})`);
  const result = spawnSync("bun", ["install"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`[install-file-deps] bun install failed in ${label}`);
    process.exit(result.status ?? 1);
  }
}
