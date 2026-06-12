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

import { repairAdaptiveThinkingOnManagedProfiles } from "../workspace/adaptive-thinking-repair.js";
import { enableAdaptiveThinkingManagedProfilesMigration } from "../workspace/migrations/097-enable-adaptive-thinking-managed-profiles.js";

const ADAPTIVE = { enabled: true, streamThinking: true };

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-adaptive-thinking-repair-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function profile(name: string): Record<string, unknown> {
  const config = readConfig();
  const llm = config.llm as Record<string, unknown>;
  const profiles = llm.profiles as Record<string, unknown>;
  return profiles[name] as Record<string, unknown>;
}

// The startup repair and migration 097 keep frozen copies of the same logic
// (migration modules must stay self-contained). Run every scenario against
// both so the copies can't drift.
const implementations: Array<[string, (dir: string) => void]> = [
  ["startup repair", repairAdaptiveThinkingOnManagedProfiles],
  [
    "migration 097",
    (dir) => enableAdaptiveThinkingManagedProfilesMigration.run(dir),
  ],
];

describe.each(implementations)("%s", (_label, run) => {
  test("patches managed Anthropic profiles missing thinking", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profiles: {
          balanced: { source: "managed", provider: "anthropic" },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            thinking: { enabled: false },
          },
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
    expect(profile("quality-optimized").thinking).toEqual(ADAPTIVE);
  });

  test("skips source-less empty shells when llm.default.provider is non-Anthropic", () => {
    // Migration 052 seeds empty {} shells (no source, no provider) on legacy
    // non-Anthropic workspaces. They inherit the non-Anthropic provider from
    // llm.default and must stay off the Anthropic-specific repair.
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-2.5-pro" },
        profiles: {
          balanced: {},
          "quality-optimized": {},
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced")).toEqual({});
    expect(profile("quality-optimized")).toEqual({});
  });

  test("treats absent llm.default.provider as Anthropic for source-less profiles", () => {
    writeConfig({
      llm: {
        default: { model: "claude-sonnet-4-6" },
        profiles: {
          balanced: {},
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
  });

  test("explicit Anthropic provider on the profile wins over a non-Anthropic default", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        profiles: {
          balanced: { provider: "anthropic" },
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced").thinking).toEqual(ADAPTIVE);
  });

  test("skips profiles with an explicit non-Anthropic provider", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: { provider: "gemini" },
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced").thinking).toBeUndefined();
  });

  test("skips source: user profiles", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: { source: "user", provider: "anthropic" },
        },
      },
    });

    run(workspaceDir);

    expect(profile("balanced").thinking).toBeUndefined();
  });

  test("is idempotent when thinking is already enabled", () => {
    const config = {
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          balanced: {
            source: "managed",
            thinking: { enabled: true, streamThinking: false },
          },
        },
      },
    };
    writeConfig(config);

    run(workspaceDir);

    expect(profile("balanced").thinking).toEqual({
      enabled: true,
      streamThinking: false,
    });
  });
});
