import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Move the managed quality-optimized profile from Claude Fable 5 to Opus 4.8.
//
// The assistant-side seed defaults (MANAGED_PROFILE_TEMPLATES in
// seed-inference-profiles.ts) resolve the quality-optimized model from the
// intent map, which maps to Opus 4.8. Off-platform (BYOK) instances pick this
// up on every boot because the seeder overwrites managed profiles. On-platform
// instances preserve existing profiles (the platform overlay is authoritative),
// so a workspace whose overlay supplies a Claude Fable 5 quality-optimized
// profile keeps it.
//
// Workspace migration 103 patches the on-disk config once, but it runs before
// mergeDefaultWorkspaceConfig() — and on a fresh platform hatch config.json
// may not exist yet, so the migration no-ops and is checkpointed as completed
// while the later overlay writes a Fable quality-optimized profile that
// seeding then preserves by name. lifecycle.ts calls this repair on every boot
// after profile seeding so the fix sticks: the overlay is archived once
// merged, so gating on the overlay-consuming boot alone would strand the
// profile if startup crashed between the merge and a successful repair. The
// migration keeps its own frozen copy of this logic (migration files are
// self-contained snapshots and must not be imported from).
//
// Only the managed quality-optimized profile is touched — the user-owned
// custom-quality-optimized copy is theirs to manage. Within it, only a model
// still on the previous quality-intent default is upgraded — matching by model
// value also covers the OpenRouter-prefixed ids. A profile whose model the
// user changed to anything else is left untouched.

const TARGET_PROFILES = ["quality-optimized"] as const;

const MODEL_UPGRADES: Record<string, string> = {
  "claude-fable-5": "claude-opus-4-8",
  "anthropic/claude-fable-5": "anthropic/claude-opus-4.8",
};

/**
 * Move managed quality-optimized profiles still on Claude Fable 5 to Opus 4.8.
 *
 * Idempotent: profiles already on Opus 4.8 (or any other user-chosen model)
 * are skipped.
 */
export function repairQualityProfileModel(workspaceDir: string): void {
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

  let changed = false;

  for (const name of TARGET_PROFILES) {
    const profile = readObject(profiles[name]);
    if (profile === null) continue;
    if (typeof profile.model !== "string") continue;

    const upgraded = MODEL_UPGRADES[profile.model];
    if (upgraded === undefined) continue;

    profile.model = upgraded;
    profiles[name] = profile;
    changed = true;
  }

  if (changed) {
    llm.profiles = profiles;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
