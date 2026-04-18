import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed latency-optimized call-site defaults for background LLM tasks.
 *
 * Migration 038 consolidated scattered LLM config keys but only wrote
 * per-call-site entries when the legacy config had *explicit* overrides.
 * Call sites that relied on runtime `modelIntent: "latency-optimized"`
 * (guardian copy, classifier, notifications, etc.) were left without
 * entries, causing them to fall through to `llm.default` (opus with max
 * effort) — a significant cost and latency regression.
 *
 * Seeds the missing entries with the appropriate fast model for the
 * workspace's configured provider. Runs in two modes:
 *
 *   1. **Existing workspace** (config.json present): read provider from
 *      `llm.default.provider`, merge seeds into `llm.callSites` without
 *      overwriting any user-defined overrides.
 *   2. **Fresh install** (config.json absent): write a minimal starter
 *      config with just the callSite seeds, using the default provider
 *      (anthropic — same as the schema default). `loadConfig()` runs
 *      after migrations and backfills the remaining schema defaults via
 *      `deepMergeMissing`, which preserves our seeded callSites.
 *
 * Without the fresh-install branch, new users permanently fall through
 * to `llm.default` (opus + max effort) because `LLMSchema.callSites`
 * defaults to `{}` and nothing else seeds the latency-optimized entries.
 */
export const seedLatencyCallSiteDefaultsMigration: WorkspaceMigration = {
  id: "040-seed-latency-callsite-defaults",
  description:
    "Seed latency-optimized call-site defaults for background LLM tasks",
  run(workspaceDir: string): void {
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

    // Fresh install: no config.json yet, so no explicit provider — fall
    // back to the schema default ("anthropic"). A platform-provided
    // `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` override that specifies a
    // non-anthropic provider should also set `llm.callSites` in that
    // override file, since it runs after migrations via
    // `mergeDefaultWorkspaceConfig` and will overwrite our seeds.
    const provider = readString(defaultBlock?.provider) ?? "anthropic";
    const fastModel = resolveLatencyModel(provider);
    if (fastModel === undefined) return;

    const callSites = readObject(llm.callSites) ?? {};

    const LATENCY_SITES = [
      "guardianQuestionCopy",
      "watchCommentary",
      "interactionClassifier",
      "skillCategoryInference",
      "inviteInstructionGenerator",
      "notificationDecision",
      "preferenceExtraction",
    ];

    let changed = false;

    for (const site of LATENCY_SITES) {
      if (readObject(callSites[site]) !== null) continue;
      callSites[site] = {
        model: fastModel,
        effort: "low",
        thinking: { enabled: false },
      };
      changed = true;
    }

    if (readObject(callSites.commitMessage) === null) {
      callSites.commitMessage = {
        model: fastModel,
        maxTokens: 120,
        temperature: 0.2,
        effort: "low",
        thinking: { enabled: false },
      };
      changed = true;
    }

    if (!changed) return;

    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded defaults would reintroduce the
    // cost/latency regression this migration fixes.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

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
