/**
 * clients/web postinstall.
 *
 * Three responsibilities, each with a comment block explaining why.
 *
 * 1. Symlink web's React copies into `packages/design-library/node_modules`
 *    so design-library compiles against the exact same React/ReactDOM the
 *    app uses (avoids the "two Reacts" runtime error from drift between
 *    independent installs).
 *
 * 2. Generate `clients/web/node_modules/@vellumai/assistant-api/` from the
 *    in-repo source at `assistant/src/api/`. Materializing a real package
 *    inside web's `node_modules` lets standard module resolution (Vite,
 *    tsc, bun) discover the wire-contract schemas and their transitive
 *    `zod` dep via normal walk-up — no tsconfig path mapping, no Vite
 *    alias, no sibling-node_modules hack required.
 *
 * 3. Generate the OpenAPI client (`src/generated`) if it isn't already
 *    on disk. This used to live as the tail of an inline postinstall;
 *    it's preserved here so first-install of a fresh checkout still
 *    produces a buildable tree.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// (2) Generate clients/web/node_modules/@vellumai/assistant-api/.
//
// Source of truth: `assistant/src/api/` in this repo. We copy the
// contents (recursively) into web's node_modules under the package
// name, then overwrite `package.json` with an install-shaped manifest
// that declares `zod` as a real dep — the in-repo source variant is
// `private: true` and intentionally lists no deps because daemon code
// imports it via relative paths.
//
// COPY (not symlink) because `preserveSymlinks: true` (set in both
// tsconfig and Vite for the React-identity invariant) makes walk-up
// follow the link target's real path. Symlinking back to
// `assistant/src/api/` would re-trigger the original problem: the
// schema files' `import { z } from "zod"` would walk up from the
// assistant tree, not web's node_modules.
const apiSourceRoot = path.join(repoRoot, "assistant/src/api");
const apiInstallRoot = path.join(webNodeModules, "@vellumai/assistant-api");

rmSync(apiInstallRoot, { recursive: true, force: true });
mkdirSync(apiInstallRoot, { recursive: true });
cpSync(apiSourceRoot, apiInstallRoot, { recursive: true });

// Overwrite the copied source `package.json` with the install variant.
// (The source variant is marked `private: true` and has no `dependencies`
// because the daemon imports the files via relative paths — neither
// applies to the installed-in-web copy.)
//
// Pin `zod` to exactly the version web has installed. The generated
// package shares web's `node_modules/zod`, so declaring a floating
// range here would just invite a `require/exports` mismatch on a future
// bun install if web's pin moves and the regen lags.
const webPackageJson = JSON.parse(
  readFileSync(path.join(webRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const webZodVersion = webPackageJson.dependencies?.zod;
if (!webZodVersion) {
  throw new Error(
    "[postinstall] clients/web/package.json must declare a `zod` dependency. " +
      "@vellumai/assistant-api is generated from web's node_modules and needs to know which zod version to pin to.",
  );
}
const generatedPackageJson = {
  name: "@vellumai/assistant-api",
  version: "0.0.0-generated",
  description: "Generated install of @vellumai/assistant-api. Source: assistant/src/api/.",
  type: "module",
  exports: {
    ".": "./index.ts",
  },
  dependencies: {
    zod: webZodVersion,
  },
};
writeFileSync(
  path.join(apiInstallRoot, "package.json"),
  JSON.stringify(generatedPackageJson, null, 2) + "\n",
);

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
