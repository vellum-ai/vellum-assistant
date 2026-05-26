import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Hard guard: refuse to let a Bun test runner resolve
 * `VELLUM_WORKSPACE_DIR` to anything outside the system temp directory.
 *
 * The runtime state of `Bun.main` cannot be forged by inherited env vars
 * or by a migration test setting `BUN_TEST = "0"`.
 */

/**
 * Returns true if this process is running under `bun test`.
 *
 * Heuristic: `Bun.main` is set to the test file Bun is currently running.
 * Anything ending in `.test.ts` / `.test.tsx` / `.test.js`, or anything
 * under a `__tests__/` directory, counts.
 *
 * Returns false outside a Bun runtime (e.g. node-based scripts) and
 * inside the production daemon (whose `Bun.main` is its compiled entry
 * point).
 */
export function isBunTestRunner(): boolean {
  if (typeof Bun === "undefined") return false;
  const main = Bun.main;
  if (!main) return false;
  return (
    main.endsWith(".test.ts") ||
    main.endsWith(".test.tsx") ||
    main.endsWith(".test.js") ||
    main.includes("/__tests__/")
  );
}

let cachedTmpRealpath: string | null = null;

function getTmpRealpath(): string {
  if (cachedTmpRealpath !== null) return cachedTmpRealpath;
  try {
    cachedTmpRealpath = realpathSync(tmpdir());
  } catch {
    cachedTmpRealpath = tmpdir();
  }
  return cachedTmpRealpath;
}

/**
 * Throws if a Bun test runner is about to consume a non-temporary
 * `VELLUM_WORKSPACE_DIR`. No-op outside a test runner; no-op when the
 * env var is unset (the home-directory fallback used by
 * `getWorkspaceDir()` is harmless).
 *
 * Called from `getWorkspaceDir()`, which is the funnel for every
 * workspace-derived path (DB, conversations, credentials, …). One check
 * protects all of them.
 */
export function assertTestWorkspaceIsTempDir(): void {
  if (!isBunTestRunner()) return;
  const workspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  if (!workspaceDir) return;
  const tmpRealpath = getTmpRealpath();
  if (
    workspaceDir === tmpRealpath ||
    workspaceDir.startsWith(tmpRealpath + "/")
  ) {
    return;
  }
  throw new Error(
    `Refusing to use VELLUM_WORKSPACE_DIR=${workspaceDir} from a Bun ` +
      `test runner. It must be a path under the system temp directory ` +
      `(${tmpRealpath}). The test preload ` +
      `(assistant/src/__tests__/test-preload.ts) is supposed to override ` +
      `it to a fresh mkdtempSync directory before any test code runs. If ` +
      `you are seeing this error, the preload either did not run or was ` +
      `bypassed — most likely because a transitively imported file failed ` +
      `to resolve.`,
  );
}
