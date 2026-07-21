import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { Glob } from "bun";

/**
 * Guard tests for plugin state self-containment. See `../AGENTS.md`
 * "Plugin Self-Containment".
 *
 * Plugins own their state: durable data lives in the plugin's storage dir,
 * schema is applied by the plugin's `init` hook, and cleanup happens in
 * `shutdown` / `conversation-deleted`. Plugins therefore must not reach
 * into the assistant's global persistence layer to own state:
 *
 * - `persistence/migrations/` and `persistence/steps` (the global
 *   migration chain), `persistence/schema` (main-DB tables),
 *   `persistence/db-connection` (the raw DB handle), and
 *   `persistence/raw-query` (raw SQL against the main DB) are frozen to
 *   the grandfathered `memory` plugin, whose main-DB tables predate the
 *   rule. New plugins keep their state in plugin-owned storage.
 *
 * Service-API imports (e.g. `persistence/conversation-crud`) are allowed —
 * the boundary is about owning state, not reading through APIs.
 */

const DEFAULTS_DIR = join(process.cwd(), "src/plugins/defaults");

/** Plugins allowed to import main-DB state modules. Frozen — do not add. */
const MAIN_DB_GRANDFATHERED_PLUGINS = new Set(["memory"]);

/** Import specifiers that mean a plugin is owning main-DB state. */
const MAIN_DB_STATE_PATTERN =
  /\b(?:from\s*|import\s*\(\s*)["'][^"']*persistence\/(?:schema(?:\/[^"']*)?|db-connection|raw-query|migrations\/[^"']*|steps)(?:\.js)?["']/;

function scanDefaultPlugins(
  pattern: RegExp,
): Array<{ plugin: string; file: string }> {
  const hits: Array<{ plugin: string; file: string }> = [];
  for (const relPath of new Glob("**/*.ts").scanSync({ cwd: DEFAULTS_DIR })) {
    const content = readFileSync(join(DEFAULTS_DIR, relPath), "utf-8");
    if (pattern.test(content)) {
      hits.push({ plugin: relPath.split("/")[0]!, file: relPath });
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}

describe("plugin state boundary guard", () => {
  test("main-DB state imports are frozen to grandfathered plugins", () => {
    const violations = scanDefaultPlugins(MAIN_DB_STATE_PATTERN).filter(
      ({ plugin }) => !MAIN_DB_GRANDFATHERED_PLUGINS.has(plugin),
    );
    expect(violations).toEqual([]);
  });

  test("the grandfathered set still needs its exemption", () => {
    const importers = new Set(
      scanDefaultPlugins(MAIN_DB_STATE_PATTERN).map(({ plugin }) => plugin),
    );
    for (const plugin of MAIN_DB_GRANDFATHERED_PLUGINS) {
      expect(importers.has(plugin)).toBe(true);
    }
  });
});
