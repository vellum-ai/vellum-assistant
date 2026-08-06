/**
 * Tests for workspace migration `140-repair-seed-pinned-memory-v3-live`.
 *
 * The pre-#39847 first-launch seed persisted `memory.v3.live = false` before
 * migration 105 could record the real decision, stranding brand-new
 * assistants on v2 and demoting existing v3 assistants whose config.json was
 * quarantined and reseeded. The repair flips `live` back to true only for
 * those two victim classes and never over a deliberate opt-out.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { repairSeedPinnedMemoryV3LiveMigration } from "../workspace/migrations/140-repair-seed-pinned-memory-v3-live.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-140-test-"));
  configPath = join(workspaceDir, "config.json");
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function readLive(): unknown {
  const memory = (readConfig().memory ?? {}) as Record<string, unknown>;
  const v3 = (memory.v3 ?? {}) as Record<string, unknown>;
  return v3.live;
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** A checkpoint file whose 105 entry ran `gapMs` after the earliest entry. */
function writeCheckpoints(gapMs: number): void {
  const base = Date.parse("2026-06-20T12:00:00.000Z");
  writeFileSync(
    join(workspaceDir, "data", ".workspace-migrations.json"),
    JSON.stringify(
      {
        applied: {
          "001-avatar-rename": {
            appliedAt: new Date(base).toISOString(),
            status: "completed",
          },
          "105-enable-memory-v3-live-for-new-workspaces": {
            appliedAt: new Date(base + gapMs).toISOString(),
            status: "completed",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

const FIRST_BOOT_GAP_MS = 5_000;
const UPGRADE_SWEEP_GAP_MS = 30 * 24 * 60 * 60 * 1000;

function writeSelectionRows(file: string): void {
  const db = new Database(join(workspaceDir, "data", "db", file));
  db.exec(`
    CREATE TABLE memory_v3_selections (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO memory_v3_selections (conversation_id, turn, slug, source)
      VALUES ('conv-1', 1, 'some-page', 'needle');
  `);
  db.close();
}

describe("140-repair-seed-pinned-memory-v3-live migration", () => {
  test("has correct id and is registered last", () => {
    expect(repairSeedPinnedMemoryV3LiveMigration.id).toBe(
      "140-repair-seed-pinned-memory-v3-live",
    );
    expect(repairSeedPinnedMemoryV3LiveMigration.description).toContain(
      "memory.v3.live",
    );
    // getLastWorkspaceMigrationId() reports the final entry as the registry
    // ceiling, so ordering matters: this must be registered, and everything
    // after it must carry a higher id. Asserting it stays literally last
    // would break on every migration appended after it.
    const index = WORKSPACE_MIGRATIONS.findIndex(
      (migration) => migration.id === "140-repair-seed-pinned-memory-v3-live",
    );
    expect(index).toBeGreaterThan(-1);
    for (const later of WORKSPACE_MIGRATIONS.slice(index + 1)) {
      expect(later.id > "140").toBe(true);
    }
  });

  test("flips a seed-race victim: born in the 105 era, live=false, v3 never ran", () => {
    writeConfig({
      memory: { v2: { enabled: true }, v3: { live: false } },
      llm: { activeProfile: "balanced" },
    });
    writeCheckpoints(FIRST_BOOT_GAP_MS);

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(true);
    // The rest of the config is untouched.
    const config = readConfig();
    expect((config.llm as Record<string, unknown>).activeProfile).toBe(
      "balanced",
    );
    expect(
      ((config.memory as Record<string, unknown>).v2 as Record<string, unknown>)
        .enabled,
    ).toBe(true);
  });

  test("skips new workspaces so a hatch-time opt-out override wins", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, NEW_WORKSPACE_CTX);

    expect(readLive()).toBe(false);
  });

  test("leaves an absent leaf alone: pre-105 assistants stay on the manual-upgrade path", () => {
    writeConfig({ memory: { v2: { enabled: true } } });
    writeCheckpoints(UPGRADE_SWEEP_GAP_MS);

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBeUndefined();
  });

  test("leaves live=true alone (idempotent after its own repair)", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);
    expect(readLive()).toBe(true);
    const afterFirstRun = readFileSync(configPath, "utf-8");

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);
    expect(readFileSync(configPath, "utf-8")).toBe(afterFirstRun);
  });

  test("skips a live=false workspace that was NOT born in the 105 era", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(UPGRADE_SWEEP_GAP_MS);

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("skips when the checkpoint file is missing (no era evidence)", () => {
    writeConfig({ memory: { v3: { live: false } } });

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("respects a hatch-time opt-out recorded in the archived default overlay", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    writeFileSync(
      join(workspaceDir, "default-config.json"),
      JSON.stringify({ memory: { v3: { live: false } } }, null, 2),
    );

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("an archived overlay without a memory.v3.live opt-out does not block repair", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    writeFileSync(
      join(workspaceDir, "default-config.json"),
      JSON.stringify({ llm: { activeProfile: "balanced" } }, null, 2),
    );

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(true);
  });

  test("respects a deliberate opt-out: v3 selection rows exist", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    writeSelectionRows("assistant-memory.db");

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("finds selection rows staged under the __relocating name mid-drain", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    const db = new Database(join(workspaceDir, "data", "db", "assistant.db"));
    db.exec(`
      CREATE TABLE memory_v3_selections__relocating (
        conversation_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        slug TEXT NOT NULL,
        source TEXT NOT NULL
      );
      INSERT INTO memory_v3_selections__relocating
        (conversation_id, turn, slug, source)
        VALUES ('conv-1', 1, 'some-page', 'needle');
    `);
    db.close();

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("finds selection rows in the pre-relocation assistant.db too", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    writeSelectionRows("assistant.db");

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("an empty selections table is not usage evidence", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(FIRST_BOOT_GAP_MS);
    const db = new Database(
      join(workspaceDir, "data", "db", "assistant-memory.db"),
    );
    db.exec(
      `CREATE TABLE memory_v3_selections (conversation_id TEXT, turn INTEGER)`,
    );
    db.close();

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(true);
  });

  test("quarantine carry-forward flips a demoted v3 assistant even with usage rows and an old workspace", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(UPGRADE_SWEEP_GAP_MS);
    writeSelectionRows("assistant-memory.db");
    writeFileSync(
      join(workspaceDir, "config.json.corrupt-2026-08-01T10-00-00.000Z.json"),
      JSON.stringify({ memory: { v3: { live: true } } }, null, 2),
    );

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(true);
  });

  test("salvages live=true from a truncated (unparseable) quarantined config", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(UPGRADE_SWEEP_GAP_MS);
    writeFileSync(
      join(workspaceDir, "config.json.corrupt-2026-08-01T10-00-00.000Z.json"),
      `{\n  "memory": {\n    "v3": {\n      "live": true\n    }\n  },\n  "llm": {\n    "activeProf`,
    );

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(true);
  });

  test("the NEWEST quarantined config wins", () => {
    writeConfig({ memory: { v3: { live: false } } });
    writeCheckpoints(UPGRADE_SWEEP_GAP_MS);
    writeFileSync(
      join(workspaceDir, "config.json.corrupt-2026-07-01T10-00-00.000Z.json"),
      JSON.stringify({ memory: { v3: { live: true } } }),
    );
    writeFileSync(
      join(workspaceDir, "config.json.corrupt-2026-08-01T10-00-00.000Z.json"),
      JSON.stringify({ memory: { v3: { live: false } } }),
    );

    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);

    expect(readLive()).toBe(false);
  });

  test("no-ops when config.json is missing or corrupt", () => {
    // Missing.
    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);
    expect(existsSync(configPath)).toBe(false);

    // Corrupt.
    writeFileSync(configPath, "{ not json");
    repairSeedPinnedMemoryV3LiveMigration.run(workspaceDir, UPGRADE_CTX);
    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });
});
