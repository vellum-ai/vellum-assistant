/**
 * apps/web postinstall.
 *
 * Three responsibilities, each with a comment block explaining why.
 *
 * 1. Symlink web's React copies into `packages/design-library/node_modules`
 *    so design-library compiles against the exact same React/ReactDOM the
 *    app uses (avoids the "two Reacts" runtime error from drift between
 *    independent installs).
 *
 * 2. Symlink web's `zod` next to the canonical SSE wire-contract files in
 *    `assistant/src/events/` so the source-as-package import chain that
 *    `@vellumai/assistant-api` re-exports can resolve `zod` via standard
 *    node walk-up from the schema file's location. See
 *    `assistant/src/api/README.md` for the pattern.
 *
 *    Hardcoded list: the api package's `package.json` intentionally has
 *    no `dependencies` block (the api/ barrel is purely a re-export). The
 *    runtime imports live in `assistant/src/events/*.ts`. When a new
 *    schema file in `events/` adds a new runtime dep, add it here.
 *
 * 3. Generate the OpenAPI client (`src/generated`) if it isn't already
 *    on disk. This used to live as the tail of an inline postinstall;
 *    it's preserved here so first-install of a fresh checkout still
 *    produces a buildable tree.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const webNodeModules = path.join(webRoot, "node_modules");

function ensureSymlink(target: string, linkPath: string): void {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  symlinkSync(target, linkPath);
}

// (1) design-library React symlinks.
//
// Symlink the runtime React copies (so design-library uses web's React,
// avoiding the "two Reacts" hook-mismatch crash) and REMOVE the type
// copies (so design-library type resolution falls through to web's
// `node_modules/@types/react`, keeping a single type identity).
const designLibraryNodeModules = path.join(
  repoRoot,
  "packages/design-library/node_modules",
);
for (const pkg of ["@types/react", "@types/react-dom"]) {
  const linkPath = path.join(designLibraryNodeModules, pkg);
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
for (const pkg of ["react", "react-dom"]) {
  const target = path.join(webNodeModules, pkg);
  if (!existsSync(target)) continue;
  ensureSymlink(target, path.join(designLibraryNodeModules, pkg));
}

// (2) assistant-api runtime-dep symlinks.
//
// The canonical SSE wire-contract schemas live at
// `assistant/src/events/<event>.ts`. Web consumers reach them via
// `@vellumai/assistant-api` (Vite alias + tsconfig path mapping ->
// `assistant/src/api/index.ts`, which re-exports from `../events/`).
//
// Node-style resolution walks up from the SCHEMA file's directory when
// resolving bare specifiers like `zod`. CI's web job only installs
// `apps/web/node_modules`, so we colocate a node_modules sibling next to
// the schema files containing symlinks to web's installed copies. This
// lets Vite, Bun, and tsc all agree without polluting daemon-side
// resolution.
const eventsRuntimeDeps = ["zod"];
const eventsNodeModules = path.join(
  repoRoot,
  "assistant/src/events/node_modules",
);
for (const dep of eventsRuntimeDeps) {
  const target = path.join(webNodeModules, dep);
  if (!existsSync(target)) {
    console.warn(
      `[postinstall] skipping events/ runtime dep '${dep}': ${target} does not exist. ` +
        `Add '${dep}' to apps/web/package.json so the source-as-package can find it.`,
    );
    continue;
  }
  ensureSymlink(target, path.join(eventsNodeModules, dep));
}

// (3) Generate API clients if missing. (Idempotent — only runs on fresh
// checkouts; subsequent installs are no-ops.)
if (!existsSync(path.join(webRoot, "src/generated"))) {
  const result = spawnSync("bun", ["run", "openapi-ts"], {
    cwd: webRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
