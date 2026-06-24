import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Exact system-owned default materializations. These are not user overrides, so
// matching entries are pruned and resolved through shipped call-site defaults.
const SEEDED_CALL_SITES: Record<string, Record<string, unknown>> = {
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

export const pruneSeededCallsiteDefaultsMigration: WorkspaceMigration = {
  id: "111-prune-seeded-callsite-defaults",
  description:
    "Remove seeded LLM call-site default materializations so fresh workspaces show no overrides",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) return;

    const callSites = readObject(llm.callSites);
    if (callSites === null) return;

    let changed = false;
    for (const [callSite, seed] of Object.entries(SEEDED_CALL_SITES)) {
      if (deepEqual(callSites[callSite], seed)) {
        delete callSites[callSite];
        changed = true;
      }
    }
    if (!changed) return;

    if (Object.keys(callSites).length === 0) {
      delete llm.callSites;
    } else {
      llm.callSites = callSites;
    }
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: restoring these entries would make defaults appear as
    // user-visible overrides again.
  },
};

function latencySeed(): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    thinking: { enabled: false },
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false;
    if (!deepEqual(aRecord[key], bRecord[key])) return false;
  }
  return true;
}
