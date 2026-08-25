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
import { stripUnsupportedFallbackProfilesMigration } from "../workspace/migrations/148-strip-unsupported-fallback-profiles.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import {
  loadCheckpoints,
  runWorkspaceMigrations,
} from "../workspace/migrations/runner.js";
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

function dbPath(): string {
  return join(workspaceDir, "data", "db", "assistant.db");
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
  test("has correct migration id and is registered", async () => {
    expect(renameCollidingBackupProfileNamesMigration.id).toBe(
      "147-rename-colliding-backup-profile-names",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "147-rename-colliding-backup-profile-names",
    );
  });

  test("renames a colliding user profile and rewrites supported references", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

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

  test("the code-owned backup is available under the reserved name afterwards", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

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

  test("the 147-to-148 migration sequence parses under LLMSchema", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    await stripUnsupportedFallbackProfilesMigration.run(workspaceDir);

    const migrated = readConfig().llm;
    const parsed = LLMSchema.safeParse(migrated);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.activeProfile).toBe("cost-optimized-backup-custom");
    }
    expect(migrated.profiles.scratch.fallbackProfile).toBeUndefined();
  });

  test("renames every colliding key and keeps suffixing past taken names", async () => {
    const profiles: Record<string, unknown> = {
      "balanced-backup-custom": { source: "user", speed: "fast" },
      "balanced-backup-custom-2": { source: "user", speed: "fast" },
    };
    for (const key of BACKUP_PROFILE_KEYS) {
      profiles[key] = { source: "user", provider: "anthropic" };
    }
    writeConfig({ llm: { profiles } });

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const renamed = readConfig().llm.profiles;
    expect(renamed["balanced-backup-custom-3"]).toBeDefined();
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(renamed[key]).toBeUndefined();
    }
    for (const key of BACKUP_PROFILE_KEYS.slice(1)) {
      expect(renamed[`${key}-custom`]).toBeDefined();
    }
  });

  test("never renames onto another reserved code-defined name", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

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

  test("leaves managed stubs and non-object values alone", async () => {
    writeConfig({
      llm: {
        profiles: {
          "balanced-backup": { source: "managed", status: "disabled" },
          "quality-optimized-backup": "not-a-profile",
        },
        activeProfile: "balanced-backup",
      },
    });

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

    const llm = readConfig().llm;
    expect(llm.profiles["balanced-backup"]).toEqual({
      source: "managed",
      status: "disabled",
    });
    expect(llm.profiles["quality-optimized-backup"]).toBe("not-a-profile");
    expect(llm.activeProfile).toBe("balanced-backup");
  });

  test("repoints conversation and schedule profile pins", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);

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

  test("is a no-op without a collision and idempotent on re-run", async () => {
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

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(config);

    // With a collision, a second run finds nothing left to rename.
    writeConfig({
      llm: {
        profiles: { "balanced-backup": { source: "user", speed: "fast" } },
        activeProfile: "balanced-backup",
      },
    });
    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    const first = readConfig();
    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);
  });

  test("handles missing config, missing llm block, and invalid JSON", async () => {
    await expect(
      renameCollidingBackupProfileNamesMigration.run(workspaceDir),
    ).resolves.toBeUndefined();

    writeConfig({ theme: "dark" });
    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    await expect(
      renameCollidingBackupProfileNamesMigration.run(workspaceDir),
    ).resolves.toBeUndefined();
  });

  test("retries a pin rewrite the database refuses, then completes", async () => {
    seedProfilePinTables({
      conversations: ["balanced-backup", "balanced"],
      cronJobs: ["balanced-backup"],
    });
    writeConfig({
      llm: {
        profiles: {
          "balanced-backup": { source: "user", provider: "anthropic" },
        },
        activeProfile: "balanced-backup",
      },
    });

    // A second connection holding the write lock makes every UPDATE fail with
    // SQLITE_BUSY until it commits, which is the contention the retry exists
    // for.
    const blocker = new Database(dbPath());
    blocker.run("BEGIN IMMEDIATE");
    let released = false;
    const release = setTimeout(() => {
      blocker.run("COMMIT");
      blocker.close();
      released = true;
    }, 10);

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    clearTimeout(release);

    // The lock is released from a timer, which can only fire while the
    // migration is waiting out a backoff: a first attempt that had succeeded
    // would have finished the run before this point.
    expect(released).toBe(true);
    expect(readPins("conversations")).toEqual([
      "balanced-backup-custom",
      "balanced",
    ]);
    expect(readPins("cron_jobs")).toEqual(["balanced-backup-custom"]);
    expect(readConfig().llm.activeProfile).toBe("balanced-backup-custom");
  });

  test("stays unapplied and retries on the next boot when the pins cannot be rewritten", async () => {
    seedProfilePinTables({
      conversations: ["balanced-backup"],
      cronJobs: ["balanced-backup"],
    });
    const config = {
      llm: {
        profiles: {
          "balanced-backup": { source: "user", provider: "anthropic" },
        },
        activeProfile: "balanced-backup",
      },
    };
    writeConfig(config);

    const blocker = new Database(dbPath());
    blocker.run("BEGIN IMMEDIATE");

    const firstBoot = await runWorkspaceMigrations(workspaceDir, [
      renameCollidingBackupProfileNamesMigration,
    ]);

    // Failed, not completed: the config keeps the old key, so the rename is
    // still pending and the mapping is still derivable from it.
    expect(firstBoot).toEqual({ applied: 0, skipped: 0, failed: 1 });
    expect(
      loadCheckpoints(workspaceDir).applied[
        "147-rename-colliding-backup-profile-names"
      ]?.status,
    ).toBe("failed");
    expect(readConfig()).toEqual(config);
    expect(readPins("conversations")).toEqual(["balanced-backup"]);

    blocker.run("COMMIT");
    blocker.close();

    const secondBoot = await runWorkspaceMigrations(workspaceDir, [
      renameCollidingBackupProfileNamesMigration,
    ]);

    expect(secondBoot).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(readConfig().llm.activeProfile).toBe("balanced-backup-custom");
    expect(readPins("conversations")).toEqual(["balanced-backup-custom"]);
    expect(readPins("cron_jobs")).toEqual(["balanced-backup-custom"]);
  });

  test("touches the database not at all without a collision", async () => {
    seedProfilePinTables({
      conversations: ["balanced-backup"],
      cronJobs: ["scratch"],
    });
    writeConfig({
      llm: {
        profiles: { scratch: { source: "user", speed: "fast" } },
        activeProfile: "balanced",
      },
    });

    // Holding the write lock for the whole run proves no write is attempted:
    // one would fail, and a failure now throws.
    const blocker = new Database(dbPath());
    blocker.run("BEGIN IMMEDIATE");
    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    blocker.run("COMMIT");
    blocker.close();

    expect(readPins("conversations")).toEqual(["balanced-backup"]);
    expect(readPins("cron_jobs")).toEqual(["scratch"]);
  });
});
