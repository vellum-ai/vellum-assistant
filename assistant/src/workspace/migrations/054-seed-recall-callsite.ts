import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a cost-optimized default for the `recall` LLM call site.
 *
 * Agentic recall uses an LLM to evaluate and synthesize bounded search
 * results. Without a call-site entry, it would inherit the workspace default,
 * which may be an expensive high-effort model. Prefer the canonical
 * `cost-optimized` profile when present, then fall back to the same cheap
 * provider model map used by earlier latency/cost migrations.
 *
 * Existing `llm.callSites.recall` objects are preserved exactly.
 */
export const seedRecallCallsiteMigration: WorkspaceMigration = {
  id: "054-seed-recall-callsite",
  description: "Seed cost-optimized default for recall LLM call site",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");
    const configExisted = existsSync(configPath);

    let config: Record<string, unknown> = {};
    if (configExisted) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }
    }

    const llm = readObject(config.llm) ?? {};
    const callSites = readObject(llm.callSites) ?? {};
    if (readObject(callSites.recall) !== null) return;

    // Migration 052 seeds empty `{}` profile shells for non-Anthropic
    // workspaces, so a present-but-empty `cost-optimized` profile would set
    // `profile: "cost-optimized"` here without a model and fall back to
    // `llm.default.model` — defeating the cost-optimization goal. Require the
    // profile to actually carry a model before pointing the call site at it.
    const profiles = readObject(llm.profiles) ?? {};
    const costOptimized = readObject(profiles["cost-optimized"]);
    if (
      costOptimized !== null &&
      readString(costOptimized.model) !== undefined
    ) {
      callSites.recall = {
        profile: "cost-optimized",
        ...RECALL_LOW_COST_LEAVES,
      };
    } else {
      const defaultBlock = readObject(llm.default);
      const provider = readString(defaultBlock?.provider) ?? "anthropic";
      const cheapModel = resolveLatencyModel(provider);
      if (cheapModel === undefined) return;

      callSites.recall = {
        model: cheapModel,
        ...RECALL_LOW_COST_LEAVES,
      };
    }

    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded default would make recall inherit
    // potentially expensive workspace defaults again.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const RECALL_LOW_COST_LEAVES = {
  maxTokens: 4096,
  effort: "low",
  thinking: { enabled: false, streamThinking: false },
  temperature: 0,
};

const PROVIDER_LATENCY_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-nano",
  gemini: "gemini-3-flash",
  ollama: "llama3.2",
  fireworks: "accounts/fireworks/models/kimi-k2p5",
  openrouter: "anthropic/claude-haiku-4.5",
};

function resolveLatencyModel(provider: string): string | undefined {
  return PROVIDER_LATENCY_MODELS[provider];
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
