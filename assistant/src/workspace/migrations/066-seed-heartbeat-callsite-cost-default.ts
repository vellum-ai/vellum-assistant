import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a cheap, bounded default for the `heartbeatAgent` LLM call site.
 *
 * Heartbeats are default-on and now run frequently, so they should not inherit
 * the workspace's active chat profile. The default managed profile is Sonnet
 * with high effort and thinking enabled, which is appropriate for interactive
 * chat but too expensive for a periodic background triage pass.
 *
 * Preserve user-owned model selection. If `heartbeatAgent` already has a
 * `profile`, `provider`, or `model`, this migration leaves the entry unchanged
 * so call-site leaves do not silently override the selected profile/model.
 * Speed-only legacy entries from migration 038 are treated as defaultable.
 */
export const seedHeartbeatCallsiteCostDefaultMigration: WorkspaceMigration = {
  id: "066-seed-heartbeat-callsite-cost-default",
  description:
    "Seed cost-optimized defaults for the heartbeatAgent LLM call site",
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
    const defaultBlock = readObject(llm.default);
    const provider = readString(defaultBlock?.provider) ?? "anthropic";
    const cheapModel = resolveCheapModel(provider);
    if (cheapModel === undefined) return;

    const callSites = readObject(llm.callSites) ?? {};
    const existing = readObject(callSites.heartbeatAgent) ?? {};
    if (hasExplicitModelSelection(existing)) return;

    const seeded: Record<string, unknown> = { ...existing };
    let changed = false;

    const profiles = readObject(llm.profiles) ?? {};
    const costProfile = readObject(profiles["cost-optimized"]);
    if (readString(costProfile?.provider) === provider) {
      seeded.profile = "cost-optimized";
    } else {
      seeded.provider = provider;
      seeded.model = cheapModel;
    }
    changed = true;

    changed = seedMissingLeaf(seeded, "maxTokens", 2048) || changed;
    changed = seedMissingLeaf(seeded, "effort", "low") || changed;
    changed = seedMissingLeaf(seeded, "temperature", 0) || changed;

    const thinking = readObject(seeded.thinking) ?? {};
    const seededThinking = { ...thinking };
    const enabledChanged = seedMissingLeaf(seededThinking, "enabled", false);
    const streamThinkingChanged = seedMissingLeaf(
      seededThinking,
      "streamThinking",
      false,
    );
    const thinkingChanged = enabledChanged || streamThinkingChanged;
    if (thinkingChanged || readObject(seeded.thinking) === null) {
      seeded.thinking = seededThinking;
      changed = true;
    }

    const contextWindow = readObject(seeded.contextWindow) ?? {};
    const seededContextWindow = { ...contextWindow };
    const contextChanged = seedMissingLeaf(
      seededContextWindow,
      "maxInputTokens",
      16_000,
    );
    if (contextChanged || readObject(seeded.contextWindow) === null) {
      seeded.contextWindow = seededContextWindow;
      changed = true;
    }

    if (!changed) return;

    callSites.heartbeatAgent = seeded;
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded default would make frequent
    // heartbeats inherit the user's potentially expensive chat profile again.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const CHEAP_MODELS_BY_PROVIDER: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-nano",
  gemini: "gemini-3-flash",
  ollama: "llama3.2",
  fireworks: "accounts/fireworks/models/kimi-k2p5",
  openrouter: "anthropic/claude-haiku-4.5",
};

function resolveCheapModel(provider: string): string | undefined {
  return CHEAP_MODELS_BY_PROVIDER[provider];
}

function hasExplicitModelSelection(value: Record<string, unknown>): boolean {
  return "profile" in value || "provider" in value || "model" in value;
}

function seedMissingLeaf(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (key in target) return false;
  target[key] = value;
  return true;
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
