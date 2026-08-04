import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { repairStaleFireworksKimiModelIdMigration } from "../workspace/migrations/136-repair-stale-fireworks-kimi-model-id.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const STALE = "accounts/fireworks/models/kimi-k2p5";
const REPLACEMENT = "accounts/fireworks/models/deepseek-v4-flash";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-136-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("136-repair-stale-fireworks-kimi-model-id migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairStaleFireworksKimiModelIdMigration.id).toBe(
      "136-repair-stale-fireworks-kimi-model-id",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "136-repair-stale-fireworks-kimi-model-id",
    );
  });

  test("repairs the stale ID in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: STALE },
        callSites: {
          recall: { model: STALE, maxTokens: 4096 },
          heartbeat: { model: `${STALE}-tuned` },
          malformed: STALE,
        },
        profiles: {
          "cost-optimized": { provider: "vellum", model: STALE },
          legacy: { model: STALE },
        },
      },
    });

    repairStaleFireworksKimiModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    // Non-exact matches and malformed leaves are untouched.
    expect(llm.callSites.heartbeat.model).toBe(`${STALE}-tuned`);
    expect(llm.callSites.malformed).toBe(STALE);
    // Managed profiles stamped provider "vellum" carry Fireworks model IDs.
    expect(llm.profiles["cost-optimized"].model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT);
  });

  test("leaves fragments with an explicit other provider untouched", () => {
    writeConfig({
      llm: {
        default: { provider: "openai-compatible", model: STALE },
        profiles: {
          byo: { provider: "openai-compatible", model: STALE },
        },
      },
    });

    repairStaleFireworksKimiModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(STALE);
    expect(llm.profiles.byo.model).toBe(STALE);
  });

  test("is idempotent and a no-op without the stale ID", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: STALE },
        profiles: { fine: { provider: "fireworks", model: REPLACEMENT } },
      },
    });

    repairStaleFireworksKimiModelIdMigration.run(workspaceDir);
    const first = readConfig();
    repairStaleFireworksKimiModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);

    const llm = first.llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.fine.model).toBe(REPLACEMENT);
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    // No config.json at all.
    expect(() =>
      repairStaleFireworksKimiModelIdMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    repairStaleFireworksKimiModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      repairStaleFireworksKimiModelIdMigration.run(workspaceDir),
    ).not.toThrow();
  });
});
