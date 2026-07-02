/**
 * Dev cache-freshness guard for clients/web. Runs before vite (wired into the
 * `dev` script).
 *
 * `@vellumai/assistant-api` is a postinstall-generated copy inside web's
 * node_modules, so Vite PREBUNDLES it into `node_modules/.vite/deps/`. Vite's
 * optimizer cache key is derived from the dependency list + lockfile — NOT the
 * copy's file contents — so a `git pull` (or branch switch) that changes
 * assistant/src/api does not invalidate the prebundle. The next `bun run dev`
 * would keep serving the STALE prebundled copy until `.vite` is deleted by
 * hand (symptom: a runtime "module does not provide an export named X"
 * SyntaxError + blank page).
 *
 * This guard clears the Vite cache when the copy is newer than the last
 * prebundle, forcing a clean re-optimize on the next start. (Workspace members
 * like design-library are served as source, not prebundled, so they cannot go
 * stale and are not watched here. The guard dies entirely once assistant-api
 * becomes a workspace member too.)
 *
 * Best-effort: any failure logs and exits 0 so it can never block `dev`.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const webRoot = path.resolve(import.meta.dirname, "..");
const cacheDir = path.join(webRoot, "node_modules/.vite");
// `_metadata.json` is rewritten by Vite's optimizer at the end of every
// (re-)optimize and left untouched on a cache hit, so its mtime is the most
// precise "when was the prebundle last built" signal.
const depsMetadata = path.join(cacheDir, "deps/_metadata.json");
// Prebundled local deps whose file contents are NOT part of Vite's optimizer
// cache key. assistant-api is installed as a plain copy, so compare the
// installed package directory (refreshed by install when its source changes).
const prebundledDepSources = [
  path.join(webRoot, "node_modules/@vellumai/assistant-api"),
];

function mtimeMsOrZero(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Newest mtime across the directory tree (files and subdirs), 0 if absent. */
function newestMtimeMs(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return 0;
  }
  let newest = mtimeMsOrZero(dir);
  for (const rel of entries) {
    const m = mtimeMsOrZero(path.join(dir, rel));
    if (m > newest) newest = m;
  }
  return newest;
}

try {
  // No prebundle yet → nothing can be stale; the cold optimize will be fresh.
  const prebundleTime =
    mtimeMsOrZero(depsMetadata) || mtimeMsOrZero(path.join(cacheDir, "deps"));
  if (prebundleTime === 0) {
    process.exit(0);
  }

  const newestSrc = Math.max(
    0,
    ...prebundledDepSources.map((dir) => newestMtimeMs(dir)),
  );
  if (newestSrc > prebundleTime) {
    rmSync(cacheDir, { recursive: true, force: true });
    console.log(
      "[ensure-fresh-vite] a prebundled workspace dep changed since the last " +
        "prebundle — cleared clients/web/node_modules/.vite to force a fresh optimize.",
    );
  }
} catch (err) {
  console.warn("[ensure-fresh-vite] skipped (best-effort):", err);
}

process.exit(0);
