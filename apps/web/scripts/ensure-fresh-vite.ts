/**
 * Dev cache-freshness guard for apps/web. Runs before vite (wired into the
 * `dev` script).
 *
 * `@vellumai/design-library` is a `file:` dependency consumed with
 * `preserveSymlinks: true` (see vite.config.ts / postinstall.ts), so Vite
 * PREBUNDLES it into `node_modules/.vite/deps/`. Vite's optimizer cache key is
 * derived from the dependency list + lockfile — NOT the file contents of a
 * linked source dep — so a `git pull` (or branch switch) that changes
 * design-library does not invalidate the prebundle. The next `bun run dev`
 * would keep serving the STALE prebundled copy until `.vite` is deleted by
 * hand.
 *
 * This guard clears the Vite cache when any design-library source file is newer
 * than the last prebundle, forcing a clean re-optimize on the next start. The
 * in-session case — editing design-library while the dev server is already
 * running — is handled separately by the `watch-design-library` plugin in
 * vite.config.ts.
 *
 * Best-effort: any failure logs and exits 0 so it can never block `dev`.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const cacheDir = path.join(webRoot, "node_modules/.vite");
// `_metadata.json` is rewritten by Vite's optimizer at the end of every
// (re-)optimize and left untouched on a cache hit, so its mtime is the most
// precise "when was the prebundle last built" signal.
const depsMetadata = path.join(cacheDir, "deps/_metadata.json");
const designLibrarySrc = path.join(repoRoot, "packages/design-library/src");

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

  const newestSrc = newestMtimeMs(designLibrarySrc);
  if (newestSrc > prebundleTime) {
    rmSync(cacheDir, { recursive: true, force: true });
    console.log(
      "[ensure-fresh-vite] design-library changed since the last prebundle — " +
        "cleared apps/web/node_modules/.vite to force a fresh optimize.",
    );
  }
} catch (err) {
  console.warn("[ensure-fresh-vite] skipped (best-effort):", err);
}

process.exit(0);
