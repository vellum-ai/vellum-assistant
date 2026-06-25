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

import { pruneSeededCallsiteDefaultsMigration } from "../workspace/migrations/111-prune-seeded-callsite-defaults.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;
let previousOverlayPath: string | undefined;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readLlm(): Record<string, unknown> | undefined {
  return readConfig().llm as Record<string, unknown> | undefined;
}

function latencySeed(): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    thinking: { enabled: false },
  };
}

function fullSeededCallSites(): Record<string, Record<string, unknown>> {
  return {
    guardianQuestionCopy: latencySeed(),
    interactionClassifier: latencySeed(),
    skillCategoryInference: latencySeed(),
    inviteInstructionGenerator: latencySeed(),
    notificationDecision: latencySeed(),
    preferenceExtraction: latencySeed(),
    commitMessage: {
      model: "claude-haiku-4-5-20251001",
      maxTokens: 120,
      temperature: 0.2,
      effort: "low",
      thinking: { enabled: false },
    },
    conversationStarters: latencySeed(),
    conversationSummarization: {
      model: "claude-opus-4-7",
      effort: "low",
      thinking: { enabled: false },
    },
    recall: {
      profile: "cost-optimized",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
      disableCache: true,
    },
    heartbeatAgent: {
      profile: "cost-optimized",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16000 },
    },
    replySuggestion: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      thinking: { enabled: false },
      disableCache: true,
    },
    memoryRouter: {
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    },
  };
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-111-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
  previousOverlayPath = process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
});

afterEach(() => {
  if (previousOverlayPath === undefined) {
    delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  } else {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = previousOverlayPath;
  }
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("111-prune-seeded-callsite-defaults migration", () => {
  test("is registered", () => {
    expect(WORKSPACE_MIGRATIONS).toContain(
      pruneSeededCallsiteDefaultsMigration,
    );
  });

  test("no-op when config.json does not exist", () => {
    pruneSeededCallsiteDefaultsMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    pruneSeededCallsiteDefaultsMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("removes exact system-owned call-site default materializations", () => {
    writeConfig({
      llm: {
        activeProfile: "balanced",
        advisorProfile: "frontier",
        callSites: fullSeededCallSites(),
      },
    });

    pruneSeededCallsiteDefaultsMigration.run(workspaceDir);

    expect(readLlm()?.activeProfile).toBe("balanced");
    expect(readLlm()?.advisorProfile).toBe("frontier");
    expect(readLlm()?.callSites).toBeUndefined();
  });

  test("preserves user-customized call-site entries", () => {
    writeConfig({
      llm: {
        callSites: {
          ...fullSeededCallSites(),
          commitMessage: {
            model: "claude-haiku-4-5-20251001",
            maxTokens: 256,
            temperature: 0.2,
            effort: "low",
            thinking: { enabled: false },
          },
          recall: {
            profile: "cost-optimized",
            maxTokens: 4096,
            effort: "low",
            thinking: { enabled: false, streamThinking: false },
            temperature: 0,
            disableCache: false,
          },
          customSite: { profile: "frontier" },
        },
      },
    });

    pruneSeededCallsiteDefaultsMigration.run(workspaceDir);

    const callSites = readLlm()?.callSites as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(callSites).sort()).toEqual([
      "commitMessage",
      "customSite",
      "recall",
    ]);
    expect(callSites.commitMessage?.maxTokens).toBe(256);
    expect(callSites.recall?.disableCache).toBe(false);
    expect(callSites.customSite).toEqual({ profile: "frontier" });
  });

  test("platform-style config keeps gateway settings while pruning seeded call sites", () => {
    writeConfig({
      gateway: {
        unmappedPolicy: "default",
        defaultAssistantId: "self",
      },
      llm: {
        callSites: fullSeededCallSites(),
      },
    });

    pruneSeededCallsiteDefaultsMigration.run(workspaceDir);

    expect(readConfig().gateway).toEqual({
      unmappedPolicy: "default",
      defaultAssistantId: "self",
    });
    expect(readLlm()?.callSites).toBeUndefined();
  });
});
