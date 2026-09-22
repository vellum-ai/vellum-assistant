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

import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

const migration = WORKSPACE_MIGRATIONS.find(
  (entry) => entry.id === "159-rename-colliding-jev-profile-name",
)!;

let workspaceDir: string;

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
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-159-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("159-rename-colliding-jev-profile-name migration", () => {
  test("is registered under its id with checkpoint retry", () => {
    expect(migration).toBeDefined();
    expect(migration.retryFailedCheckpoint).toBe(true);
  });

  test("renames a colliding user profile and rewrites every reference", async () => {
    writeConfig({
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          "jev-managed": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-7",
            label: "Mine",
          },
          scratch: { source: "user", fallbackProfile: "jev-managed" },
          armA: { source: "user", speed: "fast" },
          blend: {
            source: "user",
            mix: [
              { profile: "jev-managed", weight: 1 },
              { profile: "armA", weight: 1 },
            ],
          },
        },
        profileOrder: ["balanced", "jev-managed", "blend"],
        activeProfile: "jev-managed",
        advisorProfile: "jev-managed",
        callSites: { recall: { profile: "jev-managed", maxTokens: 4096 } },
      },
    });
    seedProfilePinTables({
      conversations: ["jev-managed", "balanced"],
      cronJobs: ["jev-managed"],
    });

    await migration.run(workspaceDir);

    const llm = readConfig().llm;
    expect(llm.profiles["jev-managed"]).toBeUndefined();
    expect(llm.profiles["jev-managed-custom"]).toEqual({
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-7",
      label: "Mine",
    });
    expect(Object.keys(llm.profiles)).toEqual([
      "jev-managed-custom",
      "scratch",
      "armA",
      "blend",
    ]);
    expect(llm.activeProfile).toBe("jev-managed-custom");
    expect(llm.advisorProfile).toBe("jev-managed-custom");
    expect(llm.profileOrder).toEqual([
      "balanced",
      "jev-managed-custom",
      "blend",
    ]);
    expect(llm.callSites.recall.profile).toBe("jev-managed-custom");
    expect(llm.profiles.scratch.fallbackProfile).toBe("jev-managed-custom");
    expect(llm.profiles.blend.mix[0].profile).toBe("jev-managed-custom");
    expect(readPins("conversations")).toEqual([
      "jev-managed-custom",
      "balanced",
    ]);
    expect(readPins("cron_jobs")).toEqual(["jev-managed-custom"]);
  });

  test("keeps suffixing past taken and reserved names", async () => {
    writeConfig({
      llm: {
        profiles: {
          "jev-managed": {
            source: "user",
            provider: "openai",
            model: "gpt-5.5",
          },
          "jev-managed-custom": { source: "user", provider: "openai" },
        },
      },
    });

    await migration.run(workspaceDir);

    const keys = Object.keys(readConfig().llm.profiles);
    expect(keys).toEqual(["jev-managed-custom-2", "jev-managed-custom"]);
  });

  test("leaves a managed stub alone and is idempotent", async () => {
    const original = {
      llm: {
        profiles: {
          "jev-managed": { source: "managed", status: "disabled" },
          balanced: { source: "managed" },
        },
      },
    };
    writeConfig(original);

    await migration.run(workspaceDir);
    await migration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
    expect(existsSync(join(workspaceDir, "data", "db", "assistant.db"))).toBe(
      false,
    );
  });
});
