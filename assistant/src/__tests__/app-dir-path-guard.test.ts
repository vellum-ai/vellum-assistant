import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: files outside app-store.ts must not import getAppsDir and use
 * it to construct paths with an app ID. All app path construction must go
 * through getAppDirPath() or resolveAppDir() from app-store.ts.
 *
 * This prevents regressions where new code bypasses the dirName-based path
 * resolution and constructs UUID-based paths directly.
 *
 * Allowlist: only app-store.ts itself, app-git-service.ts (uses getAppsDir
 * for the git repo root, not for per-app paths), and workspace migrations
 * (self-contained, don't import from app-store).
 */

/** Files that are permitted to import getAppsDir. */
const ALLOWLIST = new Set([
  "assistant/src/memory/app-store.ts", // defines getAppsDir
  "assistant/src/memory/app-git-service.ts", // uses getAppsDir for git repo root, not per-app paths
  "assistant/src/daemon/app-source-watcher.ts", // uses getAppsDir for recursive fs.watch root, not per-app paths
]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts")
  );
}

function isMigrationFile(filePath: string): boolean {
  return filePath.includes("/workspace/migrations/");
}

describe("app directory path construction guard", () => {
  test("no non-allowlisted production files import getAppsDir", () => {
    // Search for files that import getAppsDir (not just mention it in comments)
    const pattern = "import.*getAppsDir.*from|getAppsDir\\(\\)";

    let grepOutput = "";
    try {
      grepOutput = execSync(`git grep -lE '${pattern}' -- '*.ts'`, {
        encoding: "utf-8",
        cwd: process.cwd() + "/..",
      }).trim();
    } catch (err) {
      // Exit code 1 means no matches
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (isMigrationFile(f)) return false;
      if (ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found non-allowlisted production files importing or using getAppsDir().",
        "Use getAppDirPath(appId) or resolveAppDir(appId) from app-store.ts instead.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace getAppsDir() + appId path construction with getAppDirPath(appId).",
        "If this is an intentional exception, add it to the ALLOWLIST in app-dir-path-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
