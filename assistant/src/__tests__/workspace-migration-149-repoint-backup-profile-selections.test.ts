import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { repointBackupProfileSelectionsMigration } from "../workspace/migrations/149-repoint-backup-profile-selections.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function dbPath(): string {
  return join(workspaceDir, "data", "db", "assistant.db");
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function seedProfilePinTables(): void {
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  const db = new Database(dbPath());
  db.run(
    "CREATE TABLE conversations (id TEXT PRIMARY KEY, inference_profile TEXT)",
  );
  db.run(
    "CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, inference_profile TEXT)",
  );
  db.query(
    "INSERT INTO conversations (id, inference_profile) VALUES (?, ?)",
  ).run("conv-1", "quality-optimized-backup");
  db.query("INSERT INTO cron_jobs (id, inference_profile) VALUES (?, ?)").run(
    "job-1",
    "balanced-backup",
  );
  db.close();
}

function readPins(table: "conversations" | "cron_jobs"): string[] {
  const db = new Database(dbPath());
  try {
    return (
      db
        .query(`SELECT inference_profile AS profile FROM ${table} ORDER BY id`)
        .all() as Array<{ profile: string }>
    ).map((row) => row.profile);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-149-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("149-repoint-backup-profile-selections migration", () => {
  test("is registered", () => {
    expect(repointBackupProfileSelectionsMigration.id).toBe(
      "149-repoint-backup-profile-selections",
    );
    // The "newest migration" assertion lives with whichever migration is
    // actually last; this one only has to stay in the ordered list.
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "149-repoint-backup-profile-selections",
    );
  });

  test("repoints direct config selections and preserves fallback metadata", async () => {
    writeConfig({
      llm: {
        activeProfile: "balanced-backup",
        advisorProfile: "quality-optimized-backup",
        profileOrder: ["balanced", "balanced-backup"],
        callSites: {
          mainAgent: { profile: "cost-optimized-backup" },
        },
        profiles: {
          custom: {
            mix: [{ profile: "latency-optimized-backup", weight: 1 }],
          },
          balanced: {
            source: "managed",
            fallbackProfile: "balanced-backup",
          },
        },
      },
    });

    await repointBackupProfileSelectionsMigration.run(workspaceDir);

    const llm = readConfig().llm;
    expect(llm.activeProfile).toBe("balanced");
    expect(llm.advisorProfile).toBe("quality-optimized");
    expect(llm.callSites.mainAgent.profile).toBe("cost-optimized");
    expect(llm.profiles.custom.mix[0].profile).toBe("latency-optimized");
    expect(llm.profiles.balanced.fallbackProfile).toBe("balanced-backup");
    expect(llm.profileOrder).toEqual(["balanced", "balanced-backup"]);
  });

  test("repoints conversation and schedule pins", async () => {
    seedProfilePinTables();

    await repointBackupProfileSelectionsMigration.run(workspaceDir);

    expect(readPins("conversations")).toEqual(["quality-optimized"]);
    expect(readPins("cron_jobs")).toEqual(["balanced"]);
  });

  test("is idempotent and tolerates a missing config or database", async () => {
    await expect(
      repointBackupProfileSelectionsMigration.run(workspaceDir),
    ).resolves.toBeUndefined();

    writeConfig({ llm: { activeProfile: "balanced" } });
    const before = readConfig();
    await repointBackupProfileSelectionsMigration.run(workspaceDir);
    expect(readConfig()).toEqual(before);
  });
});
