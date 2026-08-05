import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard test for the CLI-logger boundary.
 *
 * `src/cli/logger.ts` is the plain-stdout writer for short-lived `assistant …`
 * invocations. It has no level filtering and no log-file routing, so a
 * daemon-side module that reaches for it writes debug output straight to a
 * stdout the daemon may not own. When the daemon runs detached and its
 * spawning parent has closed the read end of the stdout pipe, those writes
 * fail with `EPIPE` and take the process down through the fatal-error handler.
 *
 * Daemon and shared modules use `getLogger()` from `util/logger.js`, which
 * routes to the rotating log file and skips stdout entirely when stdout is not
 * a TTY.
 *
 * `no-restricted-imports` in `eslint.config.mjs` bans this too, but matches on
 * the import specifier. This guard resolves each relative import to a path, so
 * it holds regardless of how the specifier is spelled.
 */

/** Tests run from `assistant/`. */
const ASSISTANT_ROOT = process.cwd();
const CLI_LOGGER_PATH = resolve(ASSISTANT_ROOT, "src/cli/logger.ts");

/** Modules allowed to import the CLI logger: the CLI itself, and tests. */
function isExempt(relPath: string): boolean {
  return (
    relPath.startsWith("src/cli/") ||
    relPath.includes("/__tests__/") ||
    relPath.endsWith(".test.ts")
  );
}

function findCliLoggerImporters(): string[] {
  const pattern = /\b(?:from|import)\s*\(?\s*["'](\.[^"']*logger\.js)["']/g;
  const violations = new Set<string>();

  for (const relPath of new Glob("src/**/*.ts").scanSync({
    cwd: ASSISTANT_ROOT,
  })) {
    if (isExempt(relPath)) {
      continue;
    }
    const filePath = join(ASSISTANT_ROOT, relPath);
    for (const match of readFileSync(filePath, "utf-8").matchAll(pattern)) {
      // Imports carry the compiled `.js` extension; sources are `.ts`.
      const resolved = resolve(
        dirname(filePath),
        match[1]!.replace(/\.js$/, ".ts"),
      );
      if (resolved === CLI_LOGGER_PATH) {
        violations.add(relPath);
        break;
      }
    }
  }
  return Array.from(violations).sort();
}

describe("CLI logger boundary", () => {
  test("no production module outside src/cli/ imports cli/logger", () => {
    expect(findCliLoggerImporters()).toEqual([]);
  });

  test("the guard resolves the CLI logger it is guarding", () => {
    // A typo in CLI_LOGGER_PATH would make the guard above vacuously pass.
    expect(readFileSync(CLI_LOGGER_PATH, "utf-8")).toContain("getCliLogger");
  });

  test("pinned-tabs logs through the daemon logger", () => {
    // The incident site: pinned-tab mutations run inside daemon host-browser
    // request handling, on every tab pin, select, close, and invalidation.
    const source = readFileSync(
      join(ASSISTANT_ROOT, "src/tools/browser/pinned-tabs.ts"),
      "utf-8",
    );

    expect(source).toContain('from "../../util/logger.js"');
    expect(source).toContain('getLogger("pinned-tabs")');
    expect(source).not.toContain("cli/logger");
  });
});
