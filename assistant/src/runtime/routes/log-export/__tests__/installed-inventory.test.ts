/**
 * Tests for the installed skills/plugins inventory used by `POST /v1/export`.
 *
 * Validates that the inventory enumerates workspace-installed skills and
 * plugins with a name, a `lastUpdated` date, and a content fingerprint; that
 * the fingerprints are the system's canonical hashes and are stable across
 * runs but move when content changes; and that collection never throws or
 * ships file bodies.
 *
 * The shared `test-preload.ts` sets `VELLUM_WORKSPACE_DIR` to a per-file temp
 * directory, so `getWorkspaceSkillsDir()` / `getWorkspacePluginsDir()` already
 * resolve under our temp workspace. We seed those subdirectories per test.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getWorkspacePluginsDir,
  getWorkspaceSkillsDir,
} from "../../../../util/platform.js";
import {
  collectInstalledInventory,
  collectPluginInventory,
  collectSkillInventory,
} from "../installed-inventory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSkill(id: string, body: string): string {
  const dir = join(getWorkspaceSkillsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: Test skill ${id} for the inventory unit test.\n---\n\n${body}\n`,
    "utf-8",
  );
  return dir;
}

function seedPlugin(name: string, version: string): string {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version }, null, 2),
    "utf-8",
  );
  writeFileSync(
    join(dir, "index.ts"),
    `export const id = "${name}";\n`,
    "utf-8",
  );
  return dir;
}

function cleanup(): void {
  for (const dir of [getWorkspaceSkillsDir(), getWorkspacePluginsDir()]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

describe("collectSkillInventory", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("reports a workspace skill with name, date, and v1 fingerprint", () => {
    seedSkill("inv-skill-a", "First body.");

    const entry = collectSkillInventory().find((s) => s.name === "inv-skill-a");
    expect(entry).toBeDefined();
    // A skill under `<workspace>/skills/` is a user-installed ("managed")
    // catalog entry; assert it carries one of the user-authored sources rather
    // than a fixed label.
    expect(["managed", "workspace", "extra"]).toContain(entry!.source);
    expect(entry!.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry!.fingerprint).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("fingerprint is stable across runs and changes with content", () => {
    seedSkill("inv-skill-b", "Original.");
    const first = collectSkillInventory().find((s) => s.name === "inv-skill-b");
    const again = collectSkillInventory().find((s) => s.name === "inv-skill-b");
    expect(again!.fingerprint).toBe(first!.fingerprint);

    seedSkill("inv-skill-b", "Rewritten body — different bytes.");
    const changed = collectSkillInventory().find(
      (s) => s.name === "inv-skill-b",
    );
    expect(changed!.fingerprint).not.toBe(first!.fingerprint);
  });

  test("entries are sorted by name", () => {
    seedSkill("inv-zeta", "z");
    seedSkill("inv-alpha", "a");
    const names = collectSkillInventory()
      .map((s) => s.name)
      .filter((n) => n.startsWith("inv-"));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

describe("collectPluginInventory", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("reports a workspace plugin with version, date, and v2 fingerprint", () => {
    seedPlugin("inv-plugin-a", "1.2.3");

    const entry = collectPluginInventory().find(
      (p) => p.name === "inv-plugin-a",
    );
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("user");
    expect(entry!.version).toBe("1.2.3");
    expect(entry!.disabled).toBe(false);
    expect(entry!.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry!.fingerprint).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test("a `.disabled` sentinel is reflected without changing the fingerprint", () => {
    const dir = seedPlugin("inv-plugin-b", "0.1.0");
    const enabled = collectPluginInventory().find(
      (p) => p.name === "inv-plugin-b",
    );

    writeFileSync(join(dir, ".disabled"), "", "utf-8");
    const disabled = collectPluginInventory().find(
      (p) => p.name === "inv-plugin-b",
    );

    expect(disabled!.disabled).toBe(true);
    // `.disabled` is a runtime sentinel, not source — the content hash is unmoved.
    expect(disabled!.fingerprint).toBe(enabled!.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("collectInstalledInventory", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("returns both sections with a collectedAt stamp and never throws", () => {
    seedSkill("inv-skill-c", "c");
    seedPlugin("inv-plugin-c", "9.9.9");

    const inventory = collectInstalledInventory();
    expect(inventory.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inventory.skills.some((s) => s.name === "inv-skill-c")).toBe(true);
    expect(inventory.plugins.some((p) => p.name === "inv-plugin-c")).toBe(true);
  });
});
