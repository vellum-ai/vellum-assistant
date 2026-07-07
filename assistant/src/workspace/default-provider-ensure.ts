import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_PROFILE_PROVIDERS } from "../config/default-profile-names.js";
import { getIsPlatform } from "../config/env-registry.js";
import { invalidateConfigCache } from "../config/loader.js";
import { hasManagedProxyPrereqs } from "../providers/platform-proxy/context.js";

// Ensures `llm.defaultProvider` is populated on every boot.
//
// Existing installs that never ran the hatch flow need `llm.defaultProvider`
// backfilled. This is split across two pieces with workspace migration 127:
//   - The migration applies only synchronously-readable signals (a legacy
//     `llm.default.provider`, or a personal `custom-*` profile's provider)
//     and checkpoints before `mergeDefaultWorkspaceConfig()` merges the
//     platform overlay in daemon/lifecycle.ts. An overlay merged afterward
//     can rewrite `llm`, so the migration alone can't guarantee the field
//     survives.
//   - This ensure pass re-applies the same signals (platform first, then
//     the sync signals), plus a login fallback ("logged in to the
//     platform" is `hasManagedProxyPrereqs()`, an async secure-vault read
//     that a sync migration cannot perform). It runs unconditionally on every boot
//     (not gated on whether a platform overlay was merged this run) so it
//     also repairs hand-deleted fields and configs restored from backups
//     that predate the field.
//
// Idempotent: never overwrites an existing `llm.defaultProvider` value, and
// never writes `connectionName` — convention resolution
// (`resolveDefaultConnectionName`) owns the name.

const CUSTOM_PROFILE_ORDER = [
  "custom-balanced",
  "custom-quality-optimized",
  "custom-cost-optimized",
] as const;

export async function ensureDefaultProvider(
  workspaceDir: string,
): Promise<void> {
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

  const llm = readObject(config.llm) ?? {};
  if (readObject(llm.defaultProvider) !== null) {
    return;
  }

  const provider = await resolveProvider(llm);

  llm.defaultProvider = { provider };
  config.llm = llm;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  // The lifecycle call site runs before the first loadConfig() of this boot,
  // so no cached config exists yet to invalidate; this call guards callers
  // that read config before that first load (and any future reordering).
  invalidateConfigCache();
}

async function resolveProvider(llm: Record<string, unknown>): Promise<string> {
  // Platform outranks the legacy field (matching migration 127 and the hatch
  // precedence): a pre-field platform config commonly carries
  // `llm.default.provider: "anthropic"` as a schema-default echo, not a
  // routing choice, and honoring it would pin the install to a personal
  // connection. The login fallback below stays *below* the legacy field —
  // an off-platform BYOK default is the user's operative choice and being
  // logged in must not override it.
  if (getIsPlatform()) {
    return "vellum";
  }

  const legacyProvider = readObject(llm.default)?.provider;
  if (
    typeof legacyProvider === "string" &&
    isDefaultProfileProvider(legacyProvider)
  ) {
    return legacyProvider;
  }

  const profiles = readObject(llm.profiles);
  if (profiles !== null) {
    for (const name of CUSTOM_PROFILE_ORDER) {
      const entry = readObject(profiles[name]);
      if (entry === null) {
        continue;
      }
      const provider = entry.provider;
      if (typeof provider !== "string") {
        continue;
      }
      return isDefaultProfileProvider(provider)
        ? provider
        : await loginFallback();
    }
  }

  return await loginFallback();
}

async function loginFallback(): Promise<string> {
  if (await hasManagedProxyPrereqs()) {
    return "vellum";
  }
  return "anthropic";
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
