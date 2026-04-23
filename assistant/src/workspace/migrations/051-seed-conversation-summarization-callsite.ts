import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a sensible default for the `conversationSummarization` LLM call site.
 *
 * `conversationSummarization` is invoked from `ContextWindowManager.
 * updateSummary()` during mid-loop compaction. Without a call-site entry it
 * falls through to `llm.default` (opus + `effort: "max"` + `thinking:
 * { enabled: true }` + `maxTokens: 64000`), which is far too expensive for
 * summarizing a ~150k-token transcript inside the agent-loop plugin
 * pipeline's 30s budget — we were hitting `PluginTimeoutError` and hard-
 * failing the turn.
 *
 * This migration seeds `effort: "low"` and `thinking: { enabled: false }`
 * (and opus-4.7 as the model when absent) so the summary call runs cheaply
 * inside budget. Existing user-set fields are preserved — if the user has
 * explicitly configured `effort` or `thinking` for this call site, we do
 * not touch those values. Follows the pattern established by migrations
 * 040 and 046 but merges additively instead of skip-when-present, because
 * migration 038 may have already seeded a bare `{ model: ... }` entry that
 * still needs `effort` / `thinking` defaults to avoid the same fallthrough
 * to the expensive default.
 *
 *   - Skip entirely when `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set
 *     (platform overlay owns call-site seeds).
 *   - Skip when the resolved provider is not Anthropic / OpenRouter (the
 *     seeded model IDs are Anthropic-shaped; mixing with another provider
 *     would guarantee invalid-model errors).
 *   - Merge-missing semantics per leaf: never overwrite user-set values.
 *
 * Idempotent: re-running after all leaves are populated is a no-op.
 */
export const seedConversationSummarizationCallsiteMigration: WorkspaceMigration =
  {
    id: "051-seed-conversation-summarization-callsite",
    description:
      "Seed conversationSummarization LLM call-site defaults so summary runs stay inside the agent-loop budget",
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

      const explicitProvider = readString(defaultBlock?.provider);
      if (
        explicitProvider !== undefined &&
        explicitProvider !== "anthropic" &&
        explicitProvider !== "openrouter"
      ) {
        return;
      }
      const provider = explicitProvider ?? "anthropic";
      const qualityModel = resolveQualityModel(provider);
      if (qualityModel === undefined) return;

      const callSites = readObject(llm.callSites) ?? {};
      const existing = readObject(callSites.conversationSummarization) ?? {};

      // Merge-missing per leaf. Presence of the key — even with a value of
      // `false` — counts as user intent and is preserved.
      const seeded: Record<string, unknown> = { ...existing };
      let changed = false;
      if (!("model" in seeded)) {
        seeded.model = qualityModel;
        changed = true;
      }
      if (!("effort" in seeded)) {
        seeded.effort = "low";
        changed = true;
      }
      if (!("thinking" in seeded)) {
        seeded.thinking = { enabled: false };
        changed = true;
      }

      if (!changed) return;

      callSites.conversationSummarization = seeded;
      llm.callSites = callSites;
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only: removing the seeded defaults would reintroduce the
      // 30s pipeline-budget timeout this migration fixes.
    },
  };

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const PROVIDER_QUALITY_MODELS: Record<string, string> = {
  anthropic: "claude-opus-4-7",
  openrouter: "anthropic/claude-opus-4.7",
};

function resolveQualityModel(provider: string): string | undefined {
  return PROVIDER_QUALITY_MODELS[provider];
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
