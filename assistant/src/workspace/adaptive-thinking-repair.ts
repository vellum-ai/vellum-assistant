import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getCatalogProviderForModel } from "../providers/model-catalog.js";

// Enable adaptive thinking on the managed "balanced" and "quality-optimized"
// profiles.
//
// The assistant-side seed defaults (MANAGED_PROFILE_TEMPLATES in
// seed-inference-profiles.ts) already ship thinking: { enabled: true,
// streamThinking: true } for both profiles, which normalizes to
// { type: "adaptive" } on the wire. Off-platform (BYOK) instances pick this
// up on every boot because the seeder overwrites managed profiles. On-platform
// instances preserve existing profiles (the platform overlay is authoritative),
// so instances that were hatched before thinking was enabled in the templates
// are stuck with thinking disabled or absent.
//
// Workspace migration 097 patches the on-disk config once, but it runs before
// mergeDefaultWorkspaceConfig() which can overwrite the fix with overlay
// profiles that have thinking disabled or absent. lifecycle.ts calls this
// repair again after the overlay merge + profile seeding so the fix sticks.
// The migration keeps its own frozen copy of this logic (migration files are
// self-contained snapshots and must not be imported from).
//
// The repair patches both profiles, adding thinking: { enabled: true,
// streamThinking: true } where it's missing or explicitly disabled. It skips
// profiles that:
//   - Don't exist (no profile to patch)
//   - Already have thinking enabled (idempotent)
//   - Are source: "user" (user-created profiles are untouched)
//   - Have a non-managed, non-absent source (unknown origin)
//   - Resolve to a non-Anthropic provider (adaptive thinking is
//     Anthropic-specific). Effective provider is the profile's explicit
//     `provider`; otherwise the provider implied by a known catalog `model`
//     (mirroring the resolver's withImpliedProviders); otherwise
//     llm.default.provider — with a completely absent llm.default.provider
//     treated as Anthropic, matching migration 052's own `?? "anthropic"`
//     default. This keeps the legacy non-Anthropic empty `{}` shells seeded by
//     migration 052 off the repair while still patching profiles that pin a
//     known Claude model under a non-Anthropic default.

const ADAPTIVE_THINKING = { enabled: true, streamThinking: true } as const;
const TARGET_PROFILES = ["balanced", "quality-optimized"] as const;

/**
 * Patch managed Anthropic profiles that are missing adaptive thinking.
 *
 * Idempotent: profiles that already have thinking enabled are skipped.
 */
export function repairAdaptiveThinkingOnManagedProfiles(
  workspaceDir: string,
): void {
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

  // Profiles without an explicit provider and without a model-implied provider
  // inherit llm.default.provider at resolution time; an absent
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

    // Only patch managed Anthropic profiles.
    // Legacy profiles created before the `source` metadata field was introduced
    // have source=undefined. Treat these as managed when the profile name is one
    // of the canonical managed names (which TARGET_PROFILES already guarantees)
    // and the effective provider is Anthropic. Effective provider is the
    // explicit `provider`, else the provider implied by a known catalog
    // `model`, else the inherited llm.default.provider. Explicit
    // `source: "user"` profiles are always skipped.
    if (profile.source === "user") continue;
    if (profile.source !== undefined && profile.source !== "managed") continue;
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
}

function resolveEffectiveProvider(
  profile: Record<string, unknown>,
  defaultProvider: string,
): string {
  if (typeof profile.provider === "string") return profile.provider;
  if (typeof profile.model === "string") {
    const implied = getCatalogProviderForModel(profile.model);
    if (implied !== undefined) return implied;
  }
  return defaultProvider;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
