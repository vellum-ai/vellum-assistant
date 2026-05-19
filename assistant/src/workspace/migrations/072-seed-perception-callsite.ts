import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a cheap, bounded default for the `perception` LLM call site.
 *
 * The local perception interpreter is a frequent background path and should
 * never inherit heavyweight chat defaults (`mainAgent` profile/model/effort).
 * This migration sets low-cost defaults while preserving explicit user intent:
 *
 * - If `llm.callSites.perception` already has `profile`, `provider`, or `model`,
 *   leave it unchanged.
 * - Otherwise prefer `profile: "cost-optimized"` when that profile matches the
 *   workspace default provider; fall back to provider+cheap-model mapping.
 * - Seed bounded leaves only when absent.
 */
export const seedPerceptionCallsiteMigration: WorkspaceMigration = {
  id: "072-seed-perception-callsite",
  description: "Seed cost-optimized defaults for the perception LLM call site",
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
    const existing = readObject(callSites.perception) ?? {};
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

    changed = seedMissingLeaf(seeded, "maxTokens", 1024) || changed;
    changed = seedMissingLeaf(seeded, "effort", "low") || changed;
    changed = seedMissingLeaf(seeded, "temperature", 0) || changed;

    const thinking = readObject(seeded.thinking) ?? {};
    const seededThinking = { ...thinking };
    const thinkingEnabledChanged = seedMissingLeaf(
      seededThinking,
      "enabled",
      false,
    );
    const thinkingStreamChanged = seedMissingLeaf(
      seededThinking,
      "streamThinking",
      false,
    );
    if (thinkingEnabledChanged || thinkingStreamChanged) {
      seeded.thinking = seededThinking;
      changed = true;
    }

    const contextWindow = readObject(seeded.contextWindow) ?? {};
    const seededContextWindow = { ...contextWindow };
    const contextChanged = seedMissingLeaf(
      seededContextWindow,
      "maxInputTokens",
      8_000,
    );
    if (contextChanged) {
      seeded.contextWindow = seededContextWindow;
      changed = true;
    }

    if (!changed) return;

    callSites.perception = seeded;
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: perception should not silently regress to expensive defaults.
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
  minimax: "abab6.5s-chat",
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
