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

import { repairRetiredFireworksMinimaxModelIdMigration } from "../workspace/migrations/137-repair-retired-fireworks-minimax-model-id.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const RETIRED = "accounts/fireworks/models/minimax-m2p5";
const REPLACEMENT = "accounts/fireworks/models/minimax-m2p7";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-137-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("137-repair-retired-fireworks-minimax-model-id migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairRetiredFireworksMinimaxModelIdMigration.id).toBe(
      "137-repair-retired-fireworks-minimax-model-id",
    );
    expect(
      WORKSPACE_MIGRATIONS.some(
        (m) => m.id === "137-repair-retired-fireworks-minimax-model-id",
      ),
    ).toBe(true);
  });

  test("repairs the retired ID in default, call sites, and profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: RETIRED },
        callSites: {
          recall: { model: RETIRED, maxTokens: 4096 },
          heartbeat: { model: `${RETIRED}-tuned` },
          malformed: RETIRED,
        },
        profiles: {
          "cost-optimized": { provider: "vellum", model: RETIRED },
          legacy: { model: RETIRED },
        },
      },
    });

    repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.model).toBe(REPLACEMENT);
    expect(llm.callSites.recall.maxTokens).toBe(4096);
    // Non-exact matches and malformed leaves are untouched.
    expect(llm.callSites.heartbeat.model).toBe(`${RETIRED}-tuned`);
    expect(llm.callSites.malformed).toBe(RETIRED);
    // Managed profiles stamped provider "vellum" carry Fireworks model IDs.
    expect(llm.profiles["cost-optimized"].model).toBe(REPLACEMENT);
    expect(llm.profiles.legacy.model).toBe(REPLACEMENT);
  });

  test("leaves fragments with an explicit other provider untouched", () => {
    writeConfig({
      llm: {
        default: { provider: "openai-compatible", model: RETIRED },
        profiles: {
          byo: { provider: "openai-compatible", model: RETIRED },
        },
      },
    });

    repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, any>;
    expect(llm.default.model).toBe(RETIRED);
    expect(llm.profiles.byo.model).toBe(RETIRED);
  });

  test("is idempotent and a no-op without the retired ID", () => {
    writeConfig({
      llm: {
        default: { provider: "fireworks", model: RETIRED },
        profiles: { fine: { provider: "fireworks", model: REPLACEMENT } },
      },
    });

    repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir);
    const first = readConfig();
    repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual(first);

    const llm = first.llm as Record<string, any>;
    expect(llm.default.model).toBe(REPLACEMENT);
    expect(llm.profiles.fine.model).toBe(REPLACEMENT);
  });

  test("handles missing config, missing llm block, and invalid JSON", () => {
    // No config.json at all.
    expect(() =>
      repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir),
    ).not.toThrow();

    writeConfig({ theme: "dark" });
    repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      repairRetiredFireworksMinimaxModelIdMigration.run(workspaceDir),
    ).not.toThrow();
  });

  test("the replacement model is not the current Fireworks intent template", async () => {
    // Repairing onto the balanced-intent model would make a hand-edited
    // custom-* profile read as unedited to ensureByokDefaultProfiles.
    const { resolveModelIntent } =
      await import("../providers/model-intents.js");
    const fireworksIntentModels = (
      [
        "balanced",
        "latency-optimized",
        "quality-optimized",
        "vision-optimized",
      ] as const
    ).map((intent) => resolveModelIntent("fireworks", intent));
    expect(fireworksIntentModels).not.toContain(REPLACEMENT);
  });
});
