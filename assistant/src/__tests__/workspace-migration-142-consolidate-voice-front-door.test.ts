import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { consolidateVoiceFrontDoorMigration } from "../workspace/migrations/142-consolidate-voice-front-door.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;
let configPath: string;
let previousDefaultWorkspaceConfigPath: string | undefined;

beforeEach(() => {
  previousDefaultWorkspaceConfigPath =
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-142-test-"));
  configPath = join(workspaceDir, "config.json");
});

afterEach(() => {
  if (previousDefaultWorkspaceConfigPath === undefined) {
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  } else {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH =
      previousDefaultWorkspaceConfigPath;
  }
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

describe("142-consolidate-voice-front-door migration", () => {
  test("is registered in order", () => {
    expect(consolidateVoiceFrontDoorMigration.id).toBe(
      "142-consolidate-voice-front-door",
    );
    // getLastWorkspaceMigrationId() reports the final entry as the registry
    // ceiling, so ordering matters: this must be registered, and everything
    // after it must carry a higher id. Asserting it stays literally last
    // would break on every migration appended after it.
    const index = WORKSPACE_MIGRATIONS.findIndex(
      (migration) => migration.id === "142-consolidate-voice-front-door",
    );
    expect(index).toBeGreaterThan(-1);
    for (const later of WORKSPACE_MIGRATIONS.slice(index + 1)) {
      expect(later.id > "142").toBe(true);
    }
  });

  test("moves progress overrides and removes generated-ack tuning", () => {
    writeConfig({
      llm: {
        callSites: {
          voiceFrontDecision: { profile: "cost-optimized", effort: "low" },
          voiceFrontDoor: { profile: "latency-optimized" },
        },
      },
      liveVoice: {
        frontModel: {
          endpointDecisionTimeoutMs: 900,
          ackFirstDeltaTimeoutMs: 2500,
          ackGenerationTimeoutMs: 600,
          progress: { enabled: true },
        },
      },
    });

    consolidateVoiceFrontDoorMigration.run(workspaceDir);

    const config = readConfig();
    const llm = config.llm as Record<string, unknown>;
    const callSites = llm.callSites as Record<string, unknown>;
    expect(callSites.voiceProgressNarration).toEqual({
      profile: "cost-optimized",
      effort: "low",
    });
    expect(callSites).not.toHaveProperty("voiceFrontDecision");
    expect(callSites.voiceFrontDoor).toEqual({ profile: "latency-optimized" });

    const liveVoice = config.liveVoice as Record<string, unknown>;
    const frontModel = liveVoice.frontModel as Record<string, unknown>;
    expect(frontModel).not.toHaveProperty("ackFirstDeltaTimeoutMs");
    expect(frontModel).not.toHaveProperty("ackGenerationTimeoutMs");
    expect(frontModel.endpointDecisionTimeoutMs).toBe(900);
    expect(frontModel.progress).toEqual({ enabled: true });
  });

  test("keeps an existing progress override when both keys exist", () => {
    writeConfig({
      llm: {
        callSites: {
          voiceFrontDecision: { profile: "cost-optimized" },
          voiceProgressNarration: { profile: "latency-optimized" },
        },
      },
    });

    consolidateVoiceFrontDoorMigration.run(workspaceDir);

    const config = readConfig();
    const llm = config.llm as Record<string, unknown>;
    const callSites = llm.callSites as Record<string, unknown>;
    expect(callSites.voiceProgressNarration).toEqual({
      profile: "latency-optimized",
    });
    expect(callSites).not.toHaveProperty("voiceFrontDecision");
  });

  test("migrates saved overrides when a default config overlay is configured", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: {
        callSites: {
          voiceFrontDecision: { profile: "cost-optimized" },
        },
      },
    });

    consolidateVoiceFrontDoorMigration.run(workspaceDir);

    const config = readConfig();
    const llm = config.llm as Record<string, unknown>;
    const callSites = llm.callSites as Record<string, unknown>;
    expect(callSites.voiceProgressNarration).toEqual({
      profile: "cost-optimized",
    });
    expect(callSites).not.toHaveProperty("voiceFrontDecision");
  });

  test("is idempotent", () => {
    writeConfig({
      llm: {
        callSites: { voiceFrontDecision: { profile: "cost-optimized" } },
      },
    });

    consolidateVoiceFrontDoorMigration.run(workspaceDir);
    const first = readFileSync(configPath, "utf-8");
    consolidateVoiceFrontDoorMigration.run(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(first);
  });
});
