#!/usr/bin/env bun
/**
 * Install dependencies for the Electron dev/build flow.
 *
 * `apps/macos` and `apps/web` each declare `file:` dependencies on in-repo
 * packages (`@vellumai/local-mode`, `@vellum/design-library`), and those
 * packages declare their own `file:` deps in turn (`@vellumai/local-mode`
 * → `@vellumai/environments`). The repo intentionally uses per-package
 * `bun install` with no workspaces (see `apps/AGENTS.md`), so a `file:`
 * dependency's *own* dependencies exist only once `bun install` has run
 * inside that package's directory. Installing just the apps leaves the
 * transitive `file:` packages unlinked, which doesn't fail the install —
 * it surfaces later as a Vite/Rollup "failed to resolve <pkg>" the moment
 * the dev server loads its config, because the config imports a plugin
 * that pulls in an unlinked package.
 *
 * Resolving the transitive `file:` graph rooted at the two apps and
 * installing each package deepest-first means a clean checkout comes up
 * with a single `bun run dev`, and a newly added `file:` package is
 * covered automatically instead of reintroducing the same dead-end.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const FILE_PREFIX = "file:";

const macosRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.resolve(macosRoot, "../web");
const roots = [macosRoot, webRoot];

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
// cycle in the graph hanging the walk; deduping on `done` keeps a package
// shared by both apps from installing twice.
const ordered: string[] = [];
const done = new Set<string>();
const visiting = new Set<string>();

function visit(pkgDir: string): void {
  if (done.has(pkgDir)) return;
  if (visiting.has(pkgDir)) {
    throw new Error(`Cyclic file: dependency detected at ${pkgDir}`);
  }
  visiting.add(pkgDir);
  for (const dep of fileDepDirs(pkgDir)) visit(dep);
  visiting.delete(pkgDir);
  done.add(pkgDir);
  ordered.push(pkgDir);
}

for (const root of roots) visit(root);

for (const pkgDir of ordered) {
  const label = path.relative(path.resolve(macosRoot, "../.."), pkgDir);
  console.log(`[install-all] bun install (${label})`);
  const result = spawnSync("bun", ["install"], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`[install-all] bun install failed in ${label}`);
    process.exit(result.status ?? 1);
  }
}
