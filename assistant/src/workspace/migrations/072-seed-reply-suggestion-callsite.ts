import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a latency-optimized default for the `replySuggestion` LLM call site.
 *
 * `replySuggestion` drives the tab-to-accept ghost-text reply hint rendered in
 * the chat composer after every assistant turn (`GET /v1/suggestion`). It was
 * split out of `conversationStarters` so the empty-state chip generator and
 * the inline reply hint can be tuned independently. Without this seed the
 * call site falls through to `llm.default` — on workspaces with a
 * high-effort / extended-thinking default, every turn would kick off an
 * expensive reasoning call and reject the assistant prefill.
 *
 * Mirrors `046-seed-conversation-starters-callsite`:
 *   - Skip entirely when `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set
 *     (platform overlay owns call-site seeds).
 *   - Skip when the resolved provider is not Anthropic or OpenRouter (the
 *     seeded model IDs are Anthropic-shaped, so mixing with another
 *     provider would guarantee invalid-model errors).
 *   - No-op when `llm.callSites.replySuggestion` is already set.
 *
 * Idempotent, append-only — existing entries are untouched.
 */
export const seedReplySuggestionCallsiteMigration: WorkspaceMigration = {
  id: "072-seed-reply-suggestion-callsite",
  description:
    "Seed latency-optimized default for replySuggestion LLM call site",
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
    const fastModel = resolveLatencyModel(provider);
    if (fastModel === undefined) return;

    const callSites = readObject(llm.callSites) ?? {};
    if (readObject(callSites.replySuggestion) !== null) return;

    callSites.replySuggestion = {
      model: fastModel,
      effort: "low",
      thinking: { enabled: false },
    };

    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded default would reintroduce the
    // cost/latency regression that this migration fixes.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const PROVIDER_LATENCY_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
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
