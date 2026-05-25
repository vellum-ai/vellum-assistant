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
 * 2. Symlink web's `zod` into `assistant/src/api/node_modules/zod` so the
 *    source-as-package files under `assistant/src/api/` — which web pulls
 *    in via tsconfig.paths + Vite alias — can resolve their runtime deps
 *    via standard node walk-up. See `assistant/src/api/README.md`.
 *
 * 3. Generate the OpenAPI client (`src/generated`) if it isn't already
 *    on disk. This used to live as the tail of an inline postinstall;
 *    it's preserved here so first-install of a fresh checkout still
 *    produces a buildable tree.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
// Reads the api package's `dependencies` so adding a future dep here is
// a single-file change in `assistant/src/api/package.json`.
const apiPackageJsonPath = path.join(repoRoot, "assistant/src/api/package.json");
if (existsSync(apiPackageJsonPath)) {
  const apiPackageJson = JSON.parse(readFileSync(apiPackageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(apiPackageJson.dependencies ?? {});
  for (const dep of deps) {
    const target = path.join(webNodeModules, dep);
    if (!existsSync(target)) {
      console.warn(
        `[postinstall] skipping @vellumai/assistant-api dep '${dep}': ${target} does not exist. ` +
          `Add '${dep}' to apps/web/package.json so the source-as-package can find it.`,
      );
      continue;
    }
    const linkPath = path.join(repoRoot, "assistant/src/api/node_modules", dep);
    ensureSymlink(target, linkPath);
  }
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
