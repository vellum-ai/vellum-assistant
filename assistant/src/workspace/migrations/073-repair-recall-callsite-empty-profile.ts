import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair `llm.callSites.recall` entries that point at an empty
 * `cost-optimized` profile.
 *
 * Migration 052 seeds empty `{}` profile shells for non-Anthropic workspaces.
 * The original 054 logic treated any present `cost-optimized` profile as
 * usable, so it set `callSites.recall.profile = "cost-optimized"` without a
 * model on those workspaces — which caused the resolver to fall back to
 * `llm.default.model`, defeating the cost-optimization goal. 054 has since
 * been corrected, but workspaces that already applied it need a one-time
 * repair.
 */
export const repairRecallCallsiteEmptyProfileMigration: WorkspaceMigration = {
  id: "073-repair-recall-callsite-empty-profile",
  description:
    "Replace recall call-site profile pointer when cost-optimized profile lacks a model",
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

    const recall = readObject(callSites.recall);
    if (recall === null) return;
    if (recall.profile !== "cost-optimized") return;

    const profiles = readObject(llm.profiles) ?? {};
    const costOptimized = readObject(profiles["cost-optimized"]);
    if (
      costOptimized !== null &&
      readString(costOptimized.model) !== undefined
    ) {
      return;
    }

    const defaultBlock = readObject(llm.default);
    const provider = readString(defaultBlock?.provider) ?? "anthropic";
    const cheapModel = PROVIDER_LATENCY_MODELS[provider];
    if (cheapModel === undefined) return;

    delete recall.profile;
    recall.model = cheapModel;
    callSites.recall = recall;
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: reverting would reintroduce the broken profile pointer.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const PROVIDER_LATENCY_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-nano",
  gemini: "gemini-3-flash-preview",
  ollama: "llama3.2",
  fireworks: "accounts/fireworks/models/kimi-k2p5",
  openrouter: "anthropic/claude-haiku-4.5",
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
