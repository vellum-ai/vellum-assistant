/**
 * Guard against deriving a filesystem path from a `file:` URL's `.pathname`.
 *
 * `URL.pathname` is percent-encoded, so any path segment containing a space
 * survives as `%20` and every downstream `existsSync` / spawn against it
 * fails. This is not theoretical: macOS desktop installs live under
 * `~/Library/Application Support/…`, so the encoded form broke every
 * background worker spawn on that platform. `fileURLToPath()` decodes.
 *
 * Two shapes are checked:
 *   1. `.pathname` read off a URL built from `import.meta.url`.
 *   2. `.pathname` passed inside a `cmd: [...]` spawn array, the sink that
 *      turns an encoded path into a "Module not found" at runtime.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const SRC_DIR = join(import.meta.dir, "..");

/** This guard's own file, which necessarily contains the forbidden patterns. */
const SELF = "__tests__/file-url-path-guard.test.ts";

/** `.pathname` read off a URL derived from `import.meta.url`. */
const IMPORT_META_URL_PATHNAME =
  /import\.meta\.url[\s\S]{0,80}?\)\s*\.pathname/;

/** A `cmd: [...]` spawn array (bounded so it can't run away over a file). */
const SPAWN_CMD_ARRAY = /cmd:\s*\[[\s\S]{0,300}?\]/g;

function collectSourceFiles(rootDir: string): string[] {
  const pending = [rootDir];
  const files: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          pending.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function offenders(predicate: (source: string) => boolean): string[] {
  return collectSourceFiles(SRC_DIR)
    .map((path) => ({ path, rel: relative(SRC_DIR, path) }))
    .filter(({ rel }) => rel !== SELF)
    .filter(({ path }) => predicate(readFileSync(path, "utf-8")))
    .map(({ rel }) => rel)
    .sort();
}

describe("file URL → path guard", () => {
  test("no path is derived from import.meta.url via .pathname", () => {
    expect(
      offenders((source) => IMPORT_META_URL_PATHNAME.test(source)),
    ).toEqual([]);
  });

  test("no .pathname is passed as a spawn argument", () => {
    expect(
      offenders((source) =>
        [...source.matchAll(SPAWN_CMD_ARRAY)].some((match) =>
          match[0].includes(".pathname"),
        ),
      ),
    ).toEqual([]);
  });
});
