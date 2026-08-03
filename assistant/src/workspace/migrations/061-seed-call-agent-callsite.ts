import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed latency-safe defaults for the `callAgent` LLM call site.
 *
 * `callAgent` is the call site used for every live voice/phone turn (see
 * `voice-session-bridge.ts`'s `startVoiceTurn()`), the front-facing model
 * that must start speaking as soon as possible after the caller stops
 * talking. Migration 038 only seeds `callSites.callAgent.model` when the
 * legacy `calls.model` key was set, and migration 040's `LATENCY_SITES`
 * list never included `callAgent`. Without an `effort`/`thinking` entry, the
 * call site falls through to `llm.default` (`effort: "max"`, `thinking:
 * { enabled: true }`), so every voice/phone turn pays for a full extended
 * thinking pass before the first spoken token — a direct time-to-first-token
 * regression for a call site where callers are listening in real time.
 *
 * This migration seeds `effort: "low"` and `thinking: { enabled: false }`
 * only when those leaves are absent, leaving `model` (and any other
 * call-site field) exactly as-is — this is purely a latency fix, not a
 * model/quality change. Existing user-set `effort`/`thinking` values are
 * preserved, matching the merge-missing pattern used by migration 051 for
 * `conversationSummarization`.
 */
export const seedCallAgentCallsiteMigration: WorkspaceMigration = {
  id: "061-seed-call-agent-callsite",
  description:
    "Seed callAgent LLM call-site with low effort + disabled thinking so voice/phone turns aren't delayed by extended thinking",
  run(workspaceDir: string): void {
    // Defer to platform-provided overlays, same as prior call-site seeds.
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
    const existing = readObject(callSites.callAgent) ?? {};

    // Merge-missing per leaf. Presence of the key — even with a value of
    // `false` — counts as user intent and is preserved.
    const seeded: Record<string, unknown> = { ...existing };
    let changed = false;
    if (!("effort" in seeded)) {
      seeded.effort = "low";
      changed = true;
    }
    if (!("thinking" in seeded)) {
      seeded.thinking = { enabled: false };
      changed = true;
    }

    if (!changed) return;

    callSites.callAgent = seeded;
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded defaults would reintroduce the
    // extended-thinking time-to-first-token regression this migration fixes.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
