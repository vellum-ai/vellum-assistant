import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed the `advisor` LLM call site to pin the managed `advisor` profile.
 *
 * The advisor call site must resolve to the advisor profile's model
 * independent of the user's per-conversation chat profile. A bare
 * `CALL_SITE_DEFAULTS.advisor = { profile: "advisor" }` does NOT achieve this:
 * `effectiveDefault()` strips a bare call-site default's `profile` whenever an
 * `overrideProfile` (the per-turn chat profile) is present, so the advisor
 * profile would not be pinned for conversations with a selected chat profile.
 *
 * Seeding `llm.callSites.advisor = { profile: "advisor" }` on disk makes the
 * resolver use it directly (`site = llm.callSites?.[callSite] ?? ...`),
 * bypassing the stripping and appending the advisor profile as the highest
 * layer — above both activeProfile and overrideProfile.
 *
 * Existing `llm.callSites.advisor` objects are preserved exactly.
 */
export const seedAdvisorCallsiteMigration: WorkspaceMigration = {
  id: "105-seed-advisor-callsite",
  description: "Seed advisor LLM call site to pin the advisor profile",
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
    if (readObject(callSites.advisor) !== null) return;

    // Migration 052 seeds empty `{}` profile shells for non-Anthropic
    // workspaces, so a present-but-empty `advisor` profile would set
    // `profile: "advisor"` here without a model and fall back to
    // `llm.default.model` — defeating the pin. Require the profile to actually
    // carry a model before pointing the call site at it. If the advisor profile
    // isn't present (or lacks a model) yet, return without writing; this is
    // forward-only, so a later boot seeds it once the profile exists.
    const profiles = readObject(llm.profiles) ?? {};
    const advisor = readObject(profiles.advisor);
    if (advisor === null || readString(advisor.model) === undefined) return;

    // No extra leaves — all advisor tuning lives in the profile.
    callSites.advisor = { profile: "advisor" };

    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded default would let the advisor call site
    // be diluted by the per-conversation chat profile again.
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
