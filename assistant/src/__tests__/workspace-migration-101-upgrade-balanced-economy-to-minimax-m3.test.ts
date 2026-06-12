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

import { upgradeBalancedEconomyToMinimaxM3Migration } from "../workspace/migrations/101-upgrade-balanced-economy-to-minimax-m3.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readProfiles(): Record<string, Record<string, unknown>> {
  const llm = readConfig().llm as Record<string, unknown>;
  return llm.profiles as Record<string, Record<string, unknown>>;
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-101-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("101-upgrade-balanced-economy-to-minimax-m3 migration", () => {
  test("no-op when config.json does not exist", () => {
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when config has no llm.profiles", () => {
    const original = { llm: { default: { provider: "fireworks" } } };
    writeConfig(original);
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("upgrades balanced-economy from Kimi K2.6 and drops the logit-bias preset", () => {
    writeConfig({
      llm: {
        profiles: {
          "balanced-economy": {
            provider: "fireworks",
            provider_connection: "fireworks-managed",
            model: "accounts/fireworks/models/kimi-k2p6",
            label: "Balanced Economy",
            description: "Strong open model (Kimi K2.6) at a lower price point",
            maxTokens: 16000,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
            contextWindow: { maxInputTokens: 200000 },
            logitBias: "suppress-cjk",
          },
        },
      },
    });
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    const profile = readProfiles()["balanced-economy"]!;
    expect(profile.model).toBe("accounts/fireworks/models/minimax-m3");
    expect(profile.description).toBe(
      "Strong open model (MiniMax M3) at a lower price point",
    );
    expect(profile.maxTokens).toBe(32000);
    expect(profile.contextWindow).toEqual({ maxInputTokens: 200000 });
    expect("logitBias" in profile).toBe(false);
    expect(profile.label).toBe("Balanced Economy");
    expect(profile.effort).toBe("high");
    expect(profile.thinking).toEqual({ enabled: true, streamThinking: true });
  });

  test("leaves user-customized models untouched", () => {
    const original = {
      llm: {
        profiles: {
          "balanced-economy": {
            provider: "fireworks",
            model: "accounts/fireworks/models/deepseek-v4-pro",
            logitBias: "suppress-cjk",
          },
        },
      },
    };
    writeConfig(original);
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });

  test("leaves other profiles untouched", () => {
    writeConfig({
      llm: {
        profiles: {
          "my-kimi": {
            provider: "fireworks",
            model: "accounts/fireworks/models/kimi-k2p6",
          },
          "balanced-economy": {
            provider: "fireworks",
            model: "accounts/fireworks/models/kimi-k2p6",
          },
        },
      },
    });
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    const profiles = readProfiles();
    expect(profiles["my-kimi"]!.model).toBe(
      "accounts/fireworks/models/kimi-k2p6",
    );
    expect(profiles["balanced-economy"]!.model).toBe(
      "accounts/fireworks/models/minimax-m3",
    );
  });

  test("idempotency: no-op on already-upgraded config (no writes)", () => {
    writeConfig({
      llm: {
        profiles: {
          "balanced-economy": {
            provider: "fireworks",
            model: "accounts/fireworks/models/minimax-m3",
          },
        },
      },
    });
    const beforeContent = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    upgradeBalancedEconomyToMinimaxM3Migration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      beforeContent,
    );
  });
});
