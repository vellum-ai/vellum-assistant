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

import {
  BACKUP_PROFILE_KEYS,
  DEFAULT_PROFILE_KEYS,
} from "../config/default-profile-names.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { renameCollidingBackupProfileNamesMigration } from "../workspace/migrations/147-rename-colliding-backup-profile-names.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-147-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
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

function seedProfilePinTables(rows: {
  conversations: string[];
  cronJobs: string[];
}): void {
  mkdirSync(join(workspaceDir, "data", "db"), { recursive: true });
  const db = new Database(join(workspaceDir, "data", "db", "assistant.db"));
  db.run(
    `CREATE TABLE conversations (id TEXT PRIMARY KEY, inference_profile TEXT)`,
  );
  db.run(
    `CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, inference_profile TEXT)`,
  );
  rows.conversations.forEach((profile, index) => {
    db.query(
      `INSERT INTO conversations (id, inference_profile) VALUES (?, ?)`,
    ).run(`conv-${index}`, profile);
  });
  rows.cronJobs.forEach((profile, index) => {
    db.query(`INSERT INTO cron_jobs (id, inference_profile) VALUES (?, ?)`).run(
      `job-${index}`,
      profile,
    );
  });
  db.close();
}

function readPins(table: string): string[] {
  const db = new Database(join(workspaceDir, "data", "db", "assistant.db"));
  try {
    return (
      db
        .query(`SELECT inference_profile AS p FROM ${table} ORDER BY id`)
        .all() as Array<{ p: string }>
    ).map((row) => row.p);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("147-rename-colliding-backup-profile-names migration", () => {
  test("has correct migration id and is registered", () => {
    expect(renameCollidingBackupProfileNamesMigration.id).toBe(
      "147-rename-colliding-backup-profile-names",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "147-rename-colliding-backup-profile-names",
    );
  });

  test("renames a colliding user profile and rewrites every reference", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          "balanced-backup": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-7",
            label: "My Backup",
          },
          scratch: { source: "user", fallbackProfile: "balanced-backup" },
          armA: { source: "user", speed: "fast" },
          blend: {
            source: "user",
            mix: [
              { profile: "balanced-backup", weight: 1 },
              { profile: "armA", weight: 1 },
            ],
          },
        },
        profileOrder: ["balanced", "balanced-backup", "blend"],
        activeProfile: "balanced-backup",
        advisorProfile: "balanced-backup",
        callSites: { recall: { profile: "balanced-backup", maxTokens: 4096 } },
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const llm = readConfig().llm;
    expect(llm.profiles["balanced-backup"]).toBeUndefined();
    expect(llm.profiles["balanced-backup-custom"]).toEqual({
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-7",
      label: "My Backup",
    });
    expect(llm.activeProfile).toBe("balanced-backup-custom");
    expect(llm.advisorProfile).toBe("balanced-backup-custom");
    expect(llm.callSites.recall.profile).toBe("balanced-backup-custom");
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    expect(llm.profiles.scratch.fallbackProfile).toBe("balanced-backup-custom");
    expect(llm.profiles.blend.mix[0].profile).toBe("balanced-backup-custom");
    expect(llm.profiles.blend.mix[1].profile).toBe("armA");
    expect(llm.profileOrder).toEqual([
      "balanced",
      "balanced-backup-custom",
      "blend",
    ]);
  });

  test("the code-owned backup is available under the reserved name afterwards", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          "balanced-backup": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-7",
          },
        },
        activeProfile: "balanced-backup",
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const llm = readConfig().llm;
    // The reserved key is free, so it resolves to the code-owned backup body
    // rather than the user's profile, and the user's selection still points
    // at their own profile.
    expect(llm.profiles["balanced-backup"]).toBeUndefined();
    expect(llm.activeProfile).toBe("balanced-backup-custom");
    // A reference to the now-free reserved key remains valid on the managed
    // column, which is what the schema's always-available set encodes.
    const parsed = LLMSchema.safeParse({
      ...llm,
      activeProfile: "balanced-backup",
    });
    expect(parsed.success).toBe(true);
  });

  test("the migrated config parses under LLMSchema", () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          "cost-optimized-backup": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-7",
          },
          scratch: {
            source: "user",
            fallbackProfile: "cost-optimized-backup",
          },
        },
        profileOrder: ["cost-optimized-backup", "scratch"],
        activeProfile: "cost-optimized-backup",
        callSites: { recall: { profile: "cost-optimized-backup" } },
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const parsed = LLMSchema.safeParse(readConfig().llm);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.activeProfile).toBe("cost-optimized-backup-custom");
    }
  });

  test("renames every colliding key and keeps suffixing past taken names", () => {
    const profiles: Record<string, unknown> = {
      "balanced-backup-custom": { source: "user", speed: "fast" },
      "balanced-backup-custom-2": { source: "user", speed: "fast" },
    };
    for (const key of BACKUP_PROFILE_KEYS) {
      profiles[key] = { source: "user", provider: "anthropic" };
    }
    writeConfig({ llm: { profiles } });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const renamed = readConfig().llm.profiles;
    expect(renamed["balanced-backup-custom-3"]).toBeDefined();
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(renamed[key]).toBeUndefined();
    }
    for (const key of BACKUP_PROFILE_KEYS.slice(1)) {
      expect(renamed[`${key}-custom`]).toBeDefined();
    }
  });

  test("never renames onto another reserved code-defined name", () => {
    // Contrived: a profile literally named `<backup>-custom` would be a
    // legitimate rename target, but a reserved name never is.
    writeConfig({
      llm: {
        profiles: Object.fromEntries(
          [...DEFAULT_PROFILE_KEYS, ...BACKUP_PROFILE_KEYS, "os-beta"].map(
            (key) => [key, { source: "user", provider: "anthropic" }],
          ),
        ),
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const renamed = Object.keys(readConfig().llm.profiles);
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(renamed).toContain(`${key}-custom`);
    }
    // The user-owned entries on the non-reserved-for-this-migration names are
    // untouched: only the backup keys became newly reserved.
    for (const key of [...DEFAULT_PROFILE_KEYS, "os-beta"]) {
      expect(renamed).toContain(key);
    }
  });

  test("leaves managed stubs and non-object values alone", () => {
    writeConfig({
      llm: {
        profiles: {
          "balanced-backup": { source: "managed", status: "disabled" },
          "quality-optimized-backup": "not-a-profile",
        },
        activeProfile: "balanced-backup",
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const llm = readConfig().llm;
    expect(llm.profiles["balanced-backup"]).toEqual({
      source: "managed",
      status: "disabled",
    });
    expect(llm.profiles["quality-optimized-backup"]).toBe("not-a-profile");
    expect(llm.activeProfile).toBe("balanced-backup");
  });

  test("repoints conversation and schedule profile pins", () => {
    seedProfilePinTables({
      conversations: ["balanced-backup", "balanced", "balanced-backup"],
      cronJobs: ["balanced-backup", "scratch"],
    });
    writeConfig({
      llm: {
        profiles: {
          "balanced-backup": { source: "user", provider: "anthropic" },
          scratch: { source: "user", speed: "fast" },
        },
      },
    });

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    expect(readPins("conversations")).toEqual([
      "balanced-backup-custom",
      "balanced",
      "balanced-backup-custom",
    ]);
    expect(readPins("cron_jobs")).toEqual([
      "balanced-backup-custom",
      "scratch",
    ]);
  });

  test("is a no-op without a collision and idempotent on re-run", () => {
    const config = {
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          scratch: { source: "user", speed: "fast" },
        },
        activeProfile: "balanced",
        callSites: { recall: { profile: "balanced-backup" } },
      },
    };
    writeConfig(config);

    renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(config);

    // With a collision, a second run finds nothing left to rename.
    writeConfig({
      llm: {
        profiles: { "balanced-backup": { source: "user", speed: "fast" } },
        activeProfile: "balanced-backup",
      },
    });
    renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    const first = readConfig();
    renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    expect(() =>
      renameCollidingBackupProfileNamesMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      renameCollidingBackupProfileNamesMigration.run(workspaceDir),
    ).not.toThrow();
  });
});
