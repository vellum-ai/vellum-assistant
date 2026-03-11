/**
 * Guard test that validates bundled-tool-registry.ts stays in sync with
 * TOOLS.json declarations across all bundled skills.
 *
 * If this test fails, run:
 *   cd assistant && bun run scripts/generate-bundled-tool-registry.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "bundled-skills");
const REGISTRY_PATH = join(import.meta.dir, "..", "bundled-tool-registry.ts");

interface ToolEntry {
  executor: string;
  [key: string]: unknown;
}

interface ToolsJson {
  version: number;
  tools: ToolEntry[];
}

/** Collect all expected registry keys from TOOLS.json files. */
function collectToolsJsonKeys(): Set<string> {
  const keys = new Set<string>();
  const entries = readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_shared") continue;

    const toolsJsonPath = join(BUNDLED_SKILLS_DIR, entry.name, "TOOLS.json");
    let raw: string;
    try {
      raw = readFileSync(toolsJsonPath, "utf-8");
    } catch {
      // No TOOLS.json — skip this skill.
      continue;
    }

    const toolsJson: ToolsJson = JSON.parse(raw);
    for (const tool of toolsJson.tools) {
      keys.add(`${entry.name}:${tool.executor}`);
    }
  }

  return keys;
}

/** Extract all registry keys from bundled-tool-registry.ts source. */
function collectRegistryKeys(): Set<string> {
  const source = readFileSync(REGISTRY_PATH, "utf-8");
  const keys = new Set<string>();
  // Match both inline `["key", alias]` and multi-line `[\n    "key",` formats.
  // Registry keys always follow the pattern `skillName:tools/something.ts`.
  const pattern = /"([^"]+:tools\/[^"]+\.ts)"/g;
  for (const match of source.matchAll(pattern)) {
    keys.add(match[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bundled-tool-registry guard", () => {
  const toolsJsonKeys = collectToolsJsonKeys();
  const registryKeys = collectRegistryKeys();

  test("every TOOLS.json executor has a registry entry", () => {
    const violations: string[] = [];

    for (const key of toolsJsonKeys) {
      if (!registryKeys.has(key)) {
        violations.push(key);
      }
    }

    if (violations.length > 0) {
      const message = [
        "TOOLS.json declares executors that are missing from bundled-tool-registry.ts.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Run 'cd assistant && bun run scripts/generate-bundled-tool-registry.ts' to fix.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });

  test("registry has no stale entries", () => {
    const violations: string[] = [];

    for (const key of registryKeys) {
      if (!toolsJsonKeys.has(key)) {
        violations.push(key);
      }
    }

    if (violations.length > 0) {
      const message = [
        "bundled-tool-registry.ts contains entries not found in any TOOLS.json.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v}`),
        "",
        "Run 'cd assistant && bun run scripts/generate-bundled-tool-registry.ts' to fix.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});
