import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed a latency-optimized default for the `conversationStarters` LLM
 * call site.
 *
 * `conversationStarters` drives the reply-suggestion chip rendered in the
 * macOS client after every assistant turn. Migration 040 seeded most
 * trivial copy-generation call sites to haiku-4.5 but missed this one, so
 * it falls through to `llm.default` — on workspaces where the default is
 * a high-effort / extended-thinking configured model (e.g. Opus 4.x at
 * `effort: "xhigh"`), every turn completion kicks off an expensive
 * reasoning call that, to add insult to injury, rejects the assistant
 * message prefill the suggestion generator previously relied on with an
 * HTTP 400.
 *
 * Follows the same contract as `040-seed-latency-callsite-defaults`:
 *   - Skip entirely when `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set
 *     (platform overlay owns call-site seeds).
 *   - Skip when the resolved provider is not Anthropic (the seeded
 *     model IDs are Anthropic-shaped, so mixing with another provider
 *     would guarantee invalid-model errors).
 *   - No-op when `llm.callSites.conversationStarters` is already set.
 *
 * Idempotent, append-only — existing 040 entries are untouched.
 */
export const seedConversationStartersCallsiteMigration: WorkspaceMigration = {
  id: "046-seed-conversation-starters-callsite",
  description:
    "Seed latency-optimized default for conversationStarters LLM call site",
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
    if (readObject(callSites.conversationStarters) !== null) return;

    callSites.conversationStarters = {
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
    // cost/latency regression and the assistant-prefill 400 that this
    // migration fixes.
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
