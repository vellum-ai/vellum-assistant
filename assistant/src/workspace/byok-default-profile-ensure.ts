import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  materializeProfile,
  USER_PROFILE_TEMPLATES,
} from "../config/default-profile-catalog.js";
import {
  DEFAULT_PROFILE_KEYS,
  type DefaultProfileKey,
} from "../config/default-profile-names.js";
import { resolveDefaultConnectionName } from "../config/default-provider-resolution.js";
import { getIsPlatform } from "../config/env-registry.js";
import { invalidateConfigCache } from "../config/loader.js";
import {
  type DefaultProviderConfig,
  DefaultProviderSchema,
} from "../config/schemas/llm.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("byok-default-profile-ensure");

// Converts BYOK installs from the hatch-era profile layout (disabled managed
// stubs for the default keys plus editable `custom-*` copies) onto the
// code-defined default profiles: the stubs and unedited copies are removed so
// `balanced`/`quality-optimized`/`cost-optimized` resolve active and
// read-only from the default provider's column of the intent x provider
// matrix, and every named reference to a removed `custom-*` entry is
// repointed at the bare key. A `custom-*` copy the user edited is kept
// untouched as an ordinary user profile, references included.
//
// This is a boot ensure pass rather than a workspace migration because
// "unedited" is judged against the live catalog: the primary comparison body
// is `materializeProfile(USER_PROFILE_TEMPLATES[...])`, which resolves the
// current per-provider model intents, and migrations are frozen
// self-contained snapshots that may not import it (see
// workspace/migrations/AGENTS.md). Running unconditionally each boot (the
// `ensureDefaultProvider` pattern) also covers configs restored from backups
// and freshly-hatched installs whose seeder still wrote the legacy layout.
//
// Idempotent and write-avoidant: the file is rewritten only when at least one
// stub or copy was removed.

/**
 * A hatch stub is a thin managed entry carrying only the workspace-owned
 * overlay fields; a managed-source entry with any other key (a platform
 * overlay body) is not a stub and is left alone.
 */
const STUB_ONLY_KEYS = new Set(["source", "status", "label"]);

/**
 * Comparison ignores `label` and `status`: both are workspace-owned overlay
 * state (BYOK label suffixes, enable/disable toggles), not content edits.
 */
const IGNORED_COMPARISON_KEYS = new Set(["label", "status"]);

/**
 * Frozen hatch-era `custom-*` bodies rewritten in place by a repair
 * migration, kept as literals migration-style so later template changes
 * cannot silently widen the match set. The other profile-model migrations
 * (100, 101, 103, 108, 109, 110, 113, 123) rewrite only the managed default
 * entries, and 128's stale Grok ids predate `custom-*` seeding entirely, so
 * none of them contributes a body here.
 */
const FROZEN_HATCH_BODIES: Partial<
  Record<DefaultProfileKey, Record<string, unknown>[]>
> = {
  // 136-repair-stale-fireworks-kimi-model-id: fireworks hatches pinned the
  // then-current latency intent, accounts/fireworks/models/kimi-k2p5. The
  // migration rewrites the pin to deepseek-v4-flash (today's intent, so the
  // repaired body matches the current template above), but a config restored
  // from a pre-136 backup still carries this body.
  "cost-optimized": [
    {
      source: "user",
      description: "Fastest responses at lower cost",
      maxTokens: 8192,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 200000 },
      provider: "fireworks",
      provider_connection: "fireworks-personal",
      model: "accounts/fireworks/models/kimi-k2p5",
    },
  ],
};

export function ensureByokDefaultProfiles(workspaceDir: string): void {
  const configPath = join(workspaceDir, "config.json");
  if (!existsSync(configPath)) {
    return;
  }
  if (getIsPlatform()) {
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
  const parsedDefault = DefaultProviderSchema.safeParse(llm.defaultProvider);
  if (!parsedDefault.success || parsedDefault.data.provider === "vellum") {
    return;
  }
  const profiles = readObject(llm.profiles);
  if (profiles === null) {
    return;
  }

  let changed = false;

  // Deleting a thin disabled stub makes the default key resolve active from
  // the default provider's catalog column (and drops the stub's
  // "(Managed)"-suffixed label). User-source shadows and managed entries with
  // body keys are left alone.
  for (const key of DEFAULT_PROFILE_KEYS) {
    const entry = readObject(profiles[key]);
    if (entry === null || entry.source !== "managed") {
      continue;
    }
    if (!Object.keys(entry).every((k) => STUB_ONLY_KEYS.has(k))) {
      continue;
    }
    delete profiles[key];
    changed = true;
    log.info(
      { profile: key },
      "Removed hatch stub for a default profile; it resolves from the code catalog",
    );
  }

  const retired = new Map<string, string>();
  for (const key of DEFAULT_PROFILE_KEYS) {
    const name = `custom-${key}`;
    const entry = readObject(profiles[name]);
    if (
      entry === null ||
      !isKnownUneditedBody(entry, key, parsedDefault.data)
    ) {
      continue;
    }
    delete profiles[name];
    retired.set(name, key);
    changed = true;
    log.info(
      { profile: name, replacement: key },
      "Retired unedited hatch copy of a default profile",
    );
  }

  if (retired.size > 0) {
    repointRetiredReferences(llm, profiles, retired);
  }

  if (!changed) {
    return;
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  // The lifecycle call site runs before the first loadConfig() of this boot;
  // this guards callers that read config earlier (and future reordering).
  invalidateConfigCache();
}

function isKnownUneditedBody(
  entry: Record<string, unknown>,
  key: DefaultProfileKey,
  defaultProvider: DefaultProviderConfig,
): boolean {
  const body = comparableBody(entry);
  return knownHatchBodies(key, defaultProvider).some((known) =>
    isDeepStrictEqual(body, known),
  );
}

function knownHatchBodies(
  key: DefaultProfileKey,
  defaultProvider: DefaultProviderConfig,
): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];

  const template = USER_PROFILE_TEMPLATES[`custom-${key}`];
  if (template !== undefined) {
    bodies.push(
      comparableBody(
        materializeProfile(
          template,
          defaultProvider.provider,
          resolveDefaultConnectionName(defaultProvider),
        ) as Record<string, unknown>,
      ),
    );
  }

  for (const frozen of FROZEN_HATCH_BODIES[key] ?? []) {
    if (frozen.provider === defaultProvider.provider) {
      bodies.push(comparableBody(frozen));
    }
  }

  // 096-reduce-quality-profile-effort: hatch seeding produced effort "max"
  // on this copy until the migration rewrote it to "high". The migration
  // applied that rewrite regardless of who set the value, so an
  // effort-"max" variant of any known body counts as equally unedited.
  if (key === "quality-optimized") {
    bodies.push(...bodies.map((body) => ({ ...body, effort: "max" })));
  }

  return bodies;
}

function comparableBody(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([k]) => !IGNORED_COMPARISON_KEYS.has(k)),
  );
}

/**
 * Repoint every named reference to a retired `custom-*` entry at its bare
 * default key: `activeProfile`, `advisorProfile`, call-site `profile`
 * overrides, and mix arms on remaining profiles. The retired name is removed
 * from `profileOrder` (the bare key is seeded there on every boot).
 */
function repointRetiredReferences(
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
  retired: Map<string, string>,
): void {
  if (typeof llm.activeProfile === "string" && retired.has(llm.activeProfile)) {
    llm.activeProfile = retired.get(llm.activeProfile);
  }
  if (
    typeof llm.advisorProfile === "string" &&
    retired.has(llm.advisorProfile)
  ) {
    llm.advisorProfile = retired.get(llm.advisorProfile);
  }

  const callSites = readObject(llm.callSites);
  if (callSites !== null) {
    for (const value of Object.values(callSites)) {
      const site = readObject(value);
      if (
        site !== null &&
        typeof site.profile === "string" &&
        retired.has(site.profile)
      ) {
        site.profile = retired.get(site.profile);
      }
    }
  }

  for (const value of Object.values(profiles)) {
    const entry = readObject(value);
    if (entry === null || !Array.isArray(entry.mix)) {
      continue;
    }
    for (const arm of entry.mix) {
      const armObj = readObject(arm);
      if (
        armObj !== null &&
        typeof armObj.profile === "string" &&
        retired.has(armObj.profile)
      ) {
        armObj.profile = retired.get(armObj.profile);
      }
    }
  }

  if (Array.isArray(llm.profileOrder)) {
    llm.profileOrder = (llm.profileOrder as unknown[]).filter(
      (name) => typeof name !== "string" || !retired.has(name),
    );
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
