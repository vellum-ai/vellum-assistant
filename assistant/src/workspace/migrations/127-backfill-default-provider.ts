import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Backfill `llm.defaultProvider` for installs that never ran the hatch flow
// (which sets it directly) from deterministic, synchronously-readable
// signals: `IS_PLATFORM`, a legacy `llm.default.provider`, or a personal
// `custom-*` profile's provider.
//
// Platform installs resolve to "vellum" before the legacy field is
// consulted: a pre-field platform config commonly carries
// `llm.default.provider: "anthropic"` as a schema-default echo rather than
// a routing choice, and backfilling it would permanently pin the install to
// a personal connection (the ensure pass never overwrites an existing
// value). This mirrors the hatch precedence, where platform outranks the
// BYOK provider signal.
//
// The same schema-default echo affects the off-platform legacy read:
// `LLMConfigBase.provider` defaults to "anthropic" and the first-launch
// seed persists it, so a bare "anthropic" is ambiguous. Disambiguating it
// requires an async vault read that this sync migration cannot perform, so
// the entire resolution is deferred to the ensure pass (which checks the
// vault before profiles). The migration must not fall through to profiles
// on its own in this case — that would preempt the vault check and pin a
// real-BYOK user to the profile's provider.
//
// The remaining login-dependent fallback requires an async secure-vault
// read that a sync migration cannot perform, so that step lives in the
// post-boot ensure pass instead (workspace/default-provider-ensure.ts,
// which also re-applies these same sync signals — see that module's header
// for the full split rationale). When no signal matches here, this
// migration writes nothing rather than guessing the login fallback.
//
// Frozen copy: migration modules are self-contained snapshots and must not
// import from config modules (workspace/migrations/AGENTS.md); this list
// mirrors config/default-profile-names.ts's DEFAULT_PROFILE_PROVIDERS.
const DEFAULT_PROFILE_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "openrouter",
  "vellum",
] as const;

const CUSTOM_PROFILE_ORDER = [
  "custom-balanced",
  "custom-quality-optimized",
  "custom-cost-optimized",
] as const;

export const backfillDefaultProviderMigration: WorkspaceMigration = {
  id: "127-backfill-default-provider",
  description: "Backfill llm.defaultProvider from existing config signals",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) {
      return;
    }
    // Validity check, not shape check: LLMSchema's `.catch(undefined)` drops
    // an invalid persisted object at parse, so no reader ever saw it —
    // overwriting one is repair. Mirrors DefaultProviderSchema (frozen, like
    // the provider list above); extra keys stay valid because zod strips
    // unknown object keys at parse.
    if (isValidDefaultProvider(llm.defaultProvider)) {
      return;
    }

    const provider = isPlatform() ? "vellum" : resolveProviderSignal(llm);
    if (provider === undefined) {
      return;
    }

    llm.defaultProvider = { provider };
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function isValidDefaultProvider(value: unknown): boolean {
  const obj = readObject(value);
  if (obj === null) {
    return false;
  }
  if (
    typeof obj.provider !== "string" ||
    !isDefaultProfileProvider(obj.provider)
  ) {
    return false;
  }
  const connectionName = obj.connectionName;
  return (
    connectionName === undefined ||
    (typeof connectionName === "string" && connectionName.length > 0)
  );
}

// Frozen copy of config/env-registry.ts's IS_PLATFORM read — migration
// modules must not import from config modules (workspace/migrations/AGENTS.md).
function isPlatform(): boolean {
  return process.env.IS_PLATFORM === "true" || process.env.IS_PLATFORM === "1";
}

function resolveProviderSignal(
  llm: Record<string, unknown>,
): string | undefined {
  const legacyProvider = readObject(llm.default)?.provider;
  if (typeof legacyProvider === "string") {
    // A bare "anthropic" is the schema default (`LLMConfigBase.provider`)
    // that the first-launch seed persists, so it is ambiguous: it may be a
    // real BYOK choice or an echo with no user intent. Disambiguating
    // requires an async vault read this sync migration can't perform, so
    // defer the entire resolution to the ensure pass (which checks the
    // vault before profiles). Falling through to profiles here would
    // preempt the vault check and pin a real-BYOK user to the profile's
    // provider. Other providers can't be schema echoes.
    if (legacyProvider === "anthropic") {
      return undefined;
    }
    if (isDefaultProfileProvider(legacyProvider)) {
      return legacyProvider;
    }
  }

  const profiles = readObject(llm.profiles);
  if (profiles === null) {
    return undefined;
  }

  for (const name of CUSTOM_PROFILE_ORDER) {
    const entry = readObject(profiles[name]);
    if (entry === null) {
      continue;
    }
    const provider = entry.provider;
    if (typeof provider !== "string") {
      continue;
    }
    return isDefaultProfileProvider(provider) ? provider : undefined;
  }

  return undefined;
}

function isDefaultProfileProvider(
  value: string,
): value is (typeof DEFAULT_PROFILE_PROVIDERS)[number] {
  return (DEFAULT_PROFILE_PROVIDERS as readonly string[]).includes(value);
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
