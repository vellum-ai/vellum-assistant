/**
 * Tests for the installed skills/plugins inventory used by `POST /v1/export`.
 *
 * Validates that the inventory enumerates workspace-installed skills and
 * plugins with a name, and surfaces the `lastUpdated` date + content
 * fingerprint recorded in each one's `install-meta.json` (reused verbatim, not
 * recomputed); that entries without a sidecar report `null` for those fields;
 * and that assembly is sorted, stamped, and never throws.
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

const HASH_A = `v2:${"a".repeat(64)}`;
const HASH_B = `v2:${"b".repeat(64)}`;

function seedSkill(
  id: string,
  meta?: { installedAt: string; contentHash: string },
): string {
  const dir = join(getWorkspaceSkillsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: Test skill ${id} for the inventory unit test.\n---\n\nBody.\n`,
    "utf-8",
  );
  if (meta) {
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify({ origin: "custom", ...meta }, null, 2),
      "utf-8",
    );
  }
  return dir;
}

function seedPlugin(
  name: string,
  version: string,
  meta?: { installedAt: string; contentHash: string },
): string {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version }, null, 2),
    "utf-8",
  );
  if (meta) {
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify(
        {
          name,
          origin: "vellum",
          source: { kind: "github", owner: "o", repo: "r", ref: "main" },
          ...meta,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }
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

  test("reflects the date and fingerprint stored in install-meta.json", async () => {
    seedSkill("inv-skill-a", {
      installedAt: "2026-07-19T10:00:00.000Z",
      contentHash: HASH_A,
    });

    const entry = (await collectSkillInventory()).find(
      (s) => s.name === "inv-skill-a",
    );
    expect(entry).toBeDefined();
    // A skill under `<workspace>/skills/` is a user-installed ("managed")
    // catalog entry; assert it carries one of the user-authored sources.
    expect(["managed", "workspace", "extra"]).toContain(entry!.source);
    expect(typeof entry!.state).toBe("string");
    expect(entry!.lastUpdated).toBe("2026-07-19T10:00:00.000Z");
    expect(entry!.fingerprint).toBe(HASH_A);
  });

  test("reports null date/fingerprint when no install-meta.json exists", async () => {
    seedSkill("inv-skill-b");

    const entry = (await collectSkillInventory()).find(
      (s) => s.name === "inv-skill-b",
    );
    expect(entry).toBeDefined();
    expect(entry!.lastUpdated).toBeNull();
    expect(entry!.fingerprint).toBeNull();
  });

  test("entries are sorted by name", async () => {
    seedSkill("inv-zeta");
    seedSkill("inv-alpha");
    const names = (await collectSkillInventory())
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

  test("reports version plus the stored date and fingerprint", () => {
    seedPlugin("inv-plugin-a", "1.2.3", {
      installedAt: "2026-07-11T08:00:00.000Z",
      contentHash: HASH_B,
    });

    const entry = collectPluginInventory().find(
      (p) => p.name === "inv-plugin-a",
    );
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("user");
    expect(entry!.version).toBe("1.2.3");
    expect(entry!.disabled).toBe(false);
    expect(entry!.lastUpdated).toBe("2026-07-11T08:00:00.000Z");
    expect(entry!.fingerprint).toBe(HASH_B);
  });

  test("reflects a `.disabled` sentinel; null fields without install-meta", () => {
    const dir = seedPlugin("inv-plugin-b", "0.1.0");
    writeFileSync(join(dir, ".disabled"), "", "utf-8");

    const entry = collectPluginInventory().find(
      (p) => p.name === "inv-plugin-b",
    );
    expect(entry!.disabled).toBe(true);
    expect(entry!.version).toBe("0.1.0");
    expect(entry!.lastUpdated).toBeNull();
    expect(entry!.fingerprint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("collectInstalledInventory", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test("returns both sections with a collectedAt stamp and no errors on success", async () => {
    seedSkill("inv-skill-c");
    seedPlugin("inv-plugin-c", "9.9.9");

    const inventory = await collectInstalledInventory();
    expect(inventory.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inventory.skills.some((s) => s.name === "inv-skill-c")).toBe(true);
    expect(inventory.plugins.some((p) => p.name === "inv-plugin-c")).toBe(true);
    expect(inventory.errors).toBeUndefined();
  });
});
