import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed default inference profiles (`quality-optimized`, `balanced`,
 * `cost-optimized`) and the workspace-level `llm.activeProfile` selector.
 *
 * Inference profiles are named LLM-config fragments that the resolver
 * applies between `llm.default` and per-call-site overrides. PR 1 of the
 * inference-profiles plan added the `llm.profiles` record and
 * `llm.activeProfile` to the schema; this migration backfills the three
 * canonical profiles so existing workspaces have something to point at
 * out of the box.
 *
 * Behavior:
 *
 *   - **Anthropic providers** (default for new installs): seed all three
 *     profiles with full Anthropic model fragments and set
 *     `llm.activeProfile = "balanced"` when absent.
 *   - **Non-Anthropic providers**: seed empty `{}` shells for each profile
 *     name so the named slots exist (giving users somewhere to attach
 *     their own provider-specific configs), but do **not** set
 *     `activeProfile` — leaving it unset means the resolver continues to
 *     use `llm.default` and per-call-site entries unchanged.
 *
 * Existing values are never overwritten:
 *   - A pre-existing profile by any of the three names is left intact.
 *   - A pre-existing `activeProfile` is preserved on Anthropic workspaces.
 *   - `llm.callSites` entries are not touched — they continue to win at
 *     resolver layer 5 over both `activeProfile` and per-site `profile`
 *     references.
 *
 * **Skip when `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH` is set.** Like
 * migration 040, a platform-provided default-config overlay (applied
 * after migrations) is the authoritative source for both provider and
 * profile seeds. Skipping here avoids mismatched provider/model pairs.
 */
export const seedDefaultInferenceProfiles052: WorkspaceMigration = {
  id: "052-seed-default-inference-profiles",
  description:
    "Seed default inference profiles (quality-optimized, balanced, cost-optimized) and activeProfile",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");

    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
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
    const isAnthropic = provider === "anthropic";

    const profiles = readObject(llm.profiles) ?? {};

    let changed = false;

    for (const name of PROFILE_NAMES) {
      if (readObject(profiles[name]) !== null) continue;
      profiles[name] = isAnthropic
        ? cloneFragment(ANTHROPIC_PROFILES[name])
        : {};
      changed = true;
    }

    if (changed) {
      llm.profiles = profiles;
    }

    if (isAnthropic && llm.activeProfile === undefined) {
      llm.activeProfile = "balanced";
      changed = true;
    }

    if (!changed) return;

    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seeded profiles would break any user
    // configs that reference them via `activeProfile` or per-call-site
    // `profile`.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const PROFILE_NAMES = [
  "quality-optimized",
  "balanced",
  "cost-optimized",
] as const;

const ANTHROPIC_PROFILES: Record<
  (typeof PROFILE_NAMES)[number],
  Record<string, unknown>
> = {
  "quality-optimized": {
    provider: "anthropic",
    model: "claude-opus-4-7",
    maxTokens: 32000,
    effort: "max",
    thinking: { enabled: true, streamThinking: true },
  },
  balanced: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
  },
  "cost-optimized": {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
  },
};

function cloneFragment(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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
