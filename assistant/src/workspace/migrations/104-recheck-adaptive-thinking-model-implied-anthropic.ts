import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Re-run the adaptive-thinking repair on managed "balanced" and
// "quality-optimized" profiles, this time honoring the provider implied by a
// known Claude `model`.
//
// Migration 097 patches managed Anthropic profiles to enable adaptive thinking.
// Its original release classified a source-less profile by
// `profile.provider ?? llm.default.provider`, so a profile that omits
// `provider` but pins a known Claude `model` under a non-Anthropic default was
// treated as non-Anthropic and skipped — even though the resolver implies
// Anthropic from the model id. 097's frozen copy was later corrected to imply
// the provider from the model, but workspaces that already ran 097 have it
// checkpointed as completed, so the corrected logic never re-runs for them.
// The live startup repair (adaptive-thinking-repair.ts) only runs behind the
// hatch overlay, which is archived after hatch, so already-hatched platform
// instances are not covered either.
//
// This migration re-applies the corrected repair once for those checkpointed
// workspaces. It is idempotent: profiles that already have thinking enabled are
// left untouched, so workspaces that were already patched (or that never had
// the gap) are no-ops.
//
// The migration keeps its own frozen copy of the logic because migration
// modules are self-contained snapshots and must never be imported by other
// code.

const ADAPTIVE_THINKING = { enabled: true, streamThinking: true } as const;
const TARGET_PROFILES = ["balanced", "quality-optimized"] as const;

export const recheckAdaptiveThinkingModelImpliedAnthropicMigration: WorkspaceMigration =
  {
    id: "104-recheck-adaptive-thinking-model-implied-anthropic",
    description:
      "Re-enable adaptive thinking on managed profiles that imply Anthropic via a known Claude model",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }

      const llm = readObject(config.llm);
      if (llm === null) return;

      const profiles = readObject(llm.profiles);
      if (profiles === null) return;

      // Profiles without an explicit provider and without a model-implied
      // provider inherit llm.default.provider at resolution time; an absent
      // llm.default.provider resolves to Anthropic.
      const defaultBlock = readObject(llm.default);
      const defaultProvider =
        typeof defaultBlock?.provider === "string"
          ? defaultBlock.provider
          : "anthropic";

      let changed = false;

      for (const name of TARGET_PROFILES) {
        const profile = readObject(profiles[name]);
        if (profile === null) continue;

        // Only patch managed Anthropic profiles. Explicit `source: "user"`
        // profiles and non-managed, non-absent sources are skipped. Effective
        // provider is the explicit `provider`, else the provider implied by a
        // known Claude `model`, else the inherited llm.default.provider.
        if (profile.source === "user") continue;
        if (profile.source !== undefined && profile.source !== "managed") {
          continue;
        }
        const effectiveProvider = resolveEffectiveProvider(
          profile,
          defaultProvider,
        );
        if (effectiveProvider !== "anthropic") continue;

        // Skip if thinking is already enabled.
        const thinking = readObject(profile.thinking);
        if (thinking !== null && thinking.enabled === true) continue;

        profile.thinking = { ...ADAPTIVE_THINKING };
        profiles[name] = profile;
        changed = true;
      }

      if (changed) {
        llm.profiles = profiles;
        config.llm = llm;
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    },
    down(_workspaceDir: string): void {
      // Forward-only.
    },
  };

// Inline, conservative mirror of the resolver's catalog-based provider
// implication. Migration modules are frozen, self-contained snapshots and must
// not import the live model catalog. Anthropic's catalog model ids are bare
// `claude-*` ids (the slash-prefixed `anthropic/claude-*` ids belong to
// OpenRouter), so a profile pinning a `claude-*` model with no slash counts as
// Anthropic.
function resolveEffectiveProvider(
  profile: Record<string, unknown>,
  defaultProvider: string,
): string {
  if (typeof profile.provider === "string") return profile.provider;
  if (
    typeof profile.model === "string" &&
    profile.model.startsWith("claude-") &&
    !profile.model.includes("/")
  ) {
    return "anthropic";
  }
  return defaultProvider;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
