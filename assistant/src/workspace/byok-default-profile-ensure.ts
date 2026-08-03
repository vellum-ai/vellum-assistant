import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  materializeProfile,
  resolveDefaultProfileForProvider,
  USER_PROFILE_TEMPLATES,
} from "../config/default-profile-catalog.js";
import {
  DEFAULT_PROFILE_KEYS,
  type DefaultProfileKey,
} from "../config/default-profile-names.js";
import { getIsPlatform } from "../config/env-registry.js";
import { invalidateConfigCache } from "../config/loader.js";
import {
  type DefaultProviderConfig,
  DefaultProviderSchema,
  isByokDefaultProviderChoice,
  LLMConfigBase,
  type LLMProvider,
  type ProfileEntry,
} from "../config/schemas/llm.js";
import { getLogger } from "../util/logger.js";
import { completedProfileBody } from "./custom-profile-ensure.js";

const log = getLogger("byok-default-profile-ensure");

// Converts BYOK-hatched installs from the hatch-era profile layout (disabled
// managed stubs for the default keys plus editable `custom-*` copies) onto
// the code-defined default profiles: the stubs and unedited copies are
// removed so `balanced`/`quality-optimized`/`cost-optimized` resolve active
// and read-only from the default provider's column of the intent x provider
// matrix, and every named reference to a removed `custom-*` entry is
// repointed at the bare key. A `custom-*` copy the user edited is kept
// untouched as an ordinary user profile, references included.
//
// The pass also runs on installs whose default provider is now `vellum`
// (hatched BYOK, later platform-connected): the copy is compared against
// the provider recorded in its own body, with corroboration that the
// provider is hatch provenance and not a user re-provision (see
// `isKnownUneditedBody` / `uniformCopyProvider`).
//
// "Unedited" is judged against what hatch seeding actually left on disk, not
// the raw template: both the copy and the template are normalized through the
// completion `ensureCompleteCustomProfiles` bakes onto every user-source
// profile each boot, the model is accepted from the current intent resolution
// or a git-verified historical era (`HISTORICAL_INTENT_MODELS`), and `label`/
// `status` are user overlay state: a rename or disable survives conversion
// as a thin managed stub on the bare key (except a rename colliding with
// the frozen hatch-stub label, which is dropped at the carry arm).
// `llm.advisorProfile` and `llm.activeProfile` are re-validated in the same
// write because `seedInferenceProfiles` runs earlier in boot and judged the
// pre-conversion state.
//
// This is a boot ensure pass rather than a workspace migration because
// "unedited" is judged against the live catalog: the comparison template is
// `materializeProfile(USER_PROFILE_TEMPLATES[...])`, which resolves the
// current per-provider model intents, and migrations are frozen
// self-contained snapshots that may not import it (see
// workspace/migrations/AGENTS.md). Running unconditionally each boot (the
// `ensureDefaultProvider` pattern) also covers configs restored from backups
// and freshly-hatched installs whose seeder still wrote the legacy layout.
//
// Idempotent and write-avoidant: the file is rewritten only when at least one
// stub or copy was removed.

/**
 * The exact stub shapes BYOK hatching left on each default key: thin (only
 * the workspace-owned overlay fields), `source: "managed"`, the frozen
 * per-key label, and a `status` of `"disabled"` (seeded at hatch, #30367),
 * `"active"` (re-enabled through the guard; safe to delete because the bare
 * key resolves active post-conversion), or no `status` key at all (installs
 * that already existed when #30367 landed got only the label rewrite;
 * migration 126 thinned those bodies to `{ source, label }`). Deletion
 * requires the full shape: a thin managed entry differing in any other way
 * (a guard-side edit on the bare key, or a non-frozen label or status
 * carried off a retired copy by this pass) is user overlay state and stays.
 * The carry arm below never writes the frozen label, so a match is always
 * hatch-written modulo the status toggle. A managed-source entry with any
 * other key (a platform overlay body) is not a stub and is likewise left
 * alone.
 */
const STUB_ONLY_KEYS = new Set(["source", "status", "label", "thinking"]);
const HATCH_STUB_LABELS: Record<DefaultProfileKey, string> = {
  balanced: "Balanced (Managed)",
  "quality-optimized": "Quality (Managed)",
  "cost-optimized": "Speed (Managed)",
};

/**
 * Migration 097 and `repairAdaptiveThinkingOnManagedProfiles` stamp exactly
 * this `thinking` value onto managed anthropic-backed entries, hatch stubs
 * included, so live stubs commonly carry it (confirmed on real workspaces).
 * A stub's `thinking` must equal this frozen shape byte-for-byte to count as
 * machinery-written; any other value is treated as user state and keeps the
 * entry. The carry arm never writes `thinking`, so the idempotency invariant
 * (deletion predicate matches nothing the carry arm can produce) holds.
 */
const REPAIR_WRITTEN_THINKING = { enabled: true, streamThinking: true };

function isHatchStub(
  key: DefaultProfileKey,
  entry: Record<string, unknown>,
): boolean {
  return (
    entry.source === "managed" &&
    Object.keys(entry).every((k) => STUB_ONLY_KEYS.has(k)) &&
    (!("status" in entry) ||
      entry.status === "disabled" ||
      entry.status === "active") &&
    (!("thinking" in entry) ||
      isDeepStrictEqual(entry.thinking, REPAIR_WRITTEN_THINKING)) &&
    entry.label === HATCH_STUB_LABELS[key]
  );
}

/**
 * Hatch label suffix on the `custom-*` copies written between #29755
 * (2026-05-05) and #30232 (2026-05-10); a copy carrying
 * `"<template label> (Custom Provider)"` was never renamed.
 */
const ERA_COPY_LABEL_SUFFIX = " (Custom Provider)";

/**
 * Comparison ignores `label` and `status` (user overlay state, preserved via
 * `userOverlayState`) and `model` (checked separately against the current
 * intent resolution and `HISTORICAL_INTENT_MODELS`).
 */
const IGNORED_COMPARISON_KEYS = new Set(["label", "status", "model"]);

/**
 * Per-provider model ids that earlier intent eras pinned onto `custom-*`
 * copies, verified against `providers/model-intents.ts` git history. Hatch
 * seeding materializes a copy's model exactly once (`custom-*` seeding began
 * 2026-05-05, #29755), and the profile-model migrations (100, 103, 109, 113,
 * 123) deliberately rewrite only the managed default entries (`custom-*` is
 * the user's to manage), so an untouched copy still carries whichever value
 * its hatch-era intent resolved to. Migration 136 is the one exception: it
 * rewrote kimi-k2p5 pins (`custom-*` included) to deepseek-v4-flash in
 * place. A model listed here counts as unedited only when every non-model
 * field still matches the template.
 */
const HISTORICAL_INTENT_MODELS: Record<
  DefaultProfileKey,
  Partial<Record<string, readonly string[]>>
> = {
  balanced: {
    fireworks: [
      // balanced intent 2026-05-05 (#29755) to 2026-05-19 (#31068).
      "accounts/fireworks/models/kimi-k2p5",
      // balanced intent 2026-05-19 (#31068) to 2026-06-12 (#34726).
      "accounts/fireworks/models/kimi-k2p6",
      // migration 136's in-place rewrite of a kimi-k2p5 pin.
      "accounts/fireworks/models/deepseek-v4-flash",
    ],
  },
  "quality-optimized": {
    anthropic: [
      // quality intent 2026-05-05 (#29755) to 2026-06-11 (#34498).
      "claude-opus-4-7",
      // quality intent 2026-06-15 (#34867) to 2026-07-01 (#36859).
      "claude-opus-4-8",
    ],
    openrouter: [
      // quality intent 2026-05-05 (#29755) to 2026-06-11 (#34498).
      "anthropic/claude-opus-4.7",
      // quality intent 2026-06-15 (#34867) to 2026-07-01 (#36859).
      "anthropic/claude-opus-4.8",
    ],
    fireworks: [
      // quality intent 2026-05-05 (#29755) to 2026-05-19 (#31068).
      "accounts/fireworks/models/kimi-k2p5",
      // migration 136's in-place rewrite of a kimi-k2p5 pin.
      "accounts/fireworks/models/deepseek-v4-flash",
    ],
  },
  "cost-optimized": {
    gemini: [
      // latency intent 2026-05-05 (#29755) to 2026-05-22 (#31798).
      "gemini-3.1-flash-lite-preview",
    ],
    openai: [
      // latency intent 2026-05-05 (#29755) to 2026-07-29 (#39527).
      "gpt-5.4-nano",
    ],
    fireworks: [
      // latency intent 2026-05-05 (#29755) to 2026-07-28 (#39446). On live
      // configs migration 136 rewrote it to deepseek-v4-flash (the current
      // intent), so this survives only in configs restored from pre-136
      // backups.
      "accounts/fireworks/models/kimi-k2p5",
    ],
  },
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
  if (!parsedDefault.success) {
    return;
  }
  const profiles = readObject(llm.profiles);
  if (profiles === null) {
    return;
  }

  let changed = false;

  // Deleting a hatch stub makes the default key resolve active from the
  // default provider's catalog column (and drops the stub's suffixed label).
  for (const key of DEFAULT_PROFILE_KEYS) {
    const entry = readObject(profiles[key]);
    if (entry === null || !isHatchStub(key, entry)) {
      continue;
    }
    delete profiles[key];
    changed = true;
    log.info(
      { profile: key },
      "Removed hatch stub for a default profile; it resolves from the code catalog",
    );
  }

  // Base for normalizing bodies through the completion prior boots baked
  // onto user-source profiles (see `withCompletionBaked`).
  const completionBase = LLMConfigBase.safeParse(llm.default ?? {}).data;

  // The default provider on a BYOK default, or the uniform hatch provider
  // across the complete copy set on a vellum default; null converts nothing.
  const candidateProvider =
    parsedDefault.data.provider !== "vellum"
      ? parsedDefault.data.provider
      : uniformCopyProvider(profiles);
  const convertibleProvider =
    candidateProvider !== null && isByokDefaultProviderChoice(candidateProvider)
      ? candidateProvider
      : null;

  const retired = new Map<string, string>();
  const carriedDisables = new Set<DefaultProfileKey>();
  for (const key of DEFAULT_PROFILE_KEYS) {
    const name = `custom-${key}`;
    const entry = readObject(profiles[name]);
    if (
      entry === null ||
      !isKnownUneditedBody(entry, key, convertibleProvider, completionBase)
    ) {
      continue;
    }
    const overlay = userOverlayState(entry, key);
    delete profiles[name];
    if (overlay !== null && readObject(profiles[key]) === null) {
      const stub: Record<string, unknown> = { source: "managed", ...overlay };
      // A carried label that reproduces the hatch-stub shape is
      // indistinguishable from a genuine hatch stub and would be deleted by
      // the stub arm on the next boot, so the colliding label is never
      // carried. A carried disable survives as a label-less stub; a
      // rename-only collision leaves no overlay worth writing. When a
      // disabled copy meets a re-enabled stub, the copy's disable wins
      // (the stub arm already cleared the key): the copy governed the rail
      // dispatch actually used.
      if (isHatchStub(key, stub)) {
        delete stub.label;
      }
      if (Object.keys(stub).length > 1) {
        profiles[key] = stub;
        if (stub.status === "disabled") {
          carriedDisables.add(key);
        }
      }
    }
    retired.set(name, key);
    changed = true;
    log.info(
      { profile: name, replacement: key, carriedOverlay: overlay !== null },
      "Retired unedited hatch copy of a default profile",
    );
  }

  if (retired.size > 0) {
    repointRetiredReferences(llm, profiles, retired);
  }

  if (!changed) {
    return;
  }

  repairProfileSelections(llm, profiles, parsedDefault.data, carriedDisables);

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  // The lifecycle call site runs before the first loadConfig() of this boot;
  // this guards callers that read config earlier (and future reordering).
  invalidateConfigCache();
}

function isKnownUneditedBody(
  entry: Record<string, unknown>,
  key: DefaultProfileKey,
  convertibleProvider: LLMProvider | null,
  completionBase: LLMConfigBase | undefined,
): boolean {
  if (typeof entry.model !== "string") {
    return false;
  }
  // The comparison template comes from the copy's own recorded provider
  // (hatch materialized it once; the default provider may have changed
  // since); equality with the corroborated provider rules out a user
  // re-provision.
  if (convertibleProvider === null || entry.provider !== convertibleProvider) {
    return false;
  }
  const copyProvider = convertibleProvider;
  const template = USER_PROFILE_TEMPLATES[`custom-${key}`];
  if (template === undefined) {
    return false;
  }
  const materialized = materializeProfile(
    template,
    copyProvider,
    `${copyProvider}-personal`,
  ) as Record<string, unknown>;
  if (
    entry.model !== materialized.model &&
    !(HISTORICAL_INTENT_MODELS[key][copyProvider] ?? []).includes(entry.model)
  ) {
    return false;
  }
  // Completion skips managed-source bodies, so a copy from the era whose
  // templates wrote `source: "managed"` (#29755 to #29768, 2026-05-05) is
  // compared as if user-source to keep both sides normalized identically.
  const body = comparableBody(
    withCompletionBaked(
      entry.source === "managed" ? { ...entry, source: "user" } : entry,
      completionBase,
    ),
  );
  const known = comparableBody(
    withCompletionBaked(materialized, completionBase),
  );
  return hatchBodyVariants(known, key, copyProvider).some((variant) =>
    isDeepStrictEqual(body, variant),
  );
}

/**
 * One hatch wrote all three copies from one provider, so only the complete
 * uniform set corroborates hatch provenance for a vellum default. An
 * absent copy means the user curated the set, and a lone surviving copy
 * would otherwise count as trivially uniform and retire even when
 * re-provisioned; both return null and keep everything.
 */
function uniformCopyProvider(profiles: Record<string, unknown>): string | null {
  let provider: string | null = null;
  for (const key of DEFAULT_PROFILE_KEYS) {
    const entry = readObject(profiles[`custom-${key}`]);
    if (entry === null) {
      return null;
    }
    if (typeof entry.provider !== "string") {
      return null;
    }
    if (provider === null) {
      provider = entry.provider;
    } else if (provider !== entry.provider) {
      return null;
    }
  }
  return provider;
}

/**
 * Every shape hatch seeding and the profile migrations verifiably left on
 * disk for an untouched copy, derived from the current reference body:
 *
 * - effort "max" on the quality copy: hatch seeding wrote it until
 *   096-reduce-quality-profile-effort rewrote "max" to "high" in place,
 *   regardless of who set the value, so a "max" body (a config restored
 *   from a pre-096 backup) is equally unedited.
 * - absent `provider_connection`: hatches before #30232 (2026-05-10) never
 *   stamped one, and migration 133 drops the conventional
 *   `<provider>-personal` stamp from every entry (dispatch auto-resolves
 *   the same row from `provider`).
 * - `provider_connection` naming the bare provider: web onboarding before
 *   #39516 (2026-07-29) stamped the connection name `"<provider>"` onto the
 *   copy it authored. Safe to accept: that row resolves the same
 *   `credential/<provider>/api_key` slot as `<provider>-personal`, so
 *   retiring the copy cannot switch keys. Any other connection value is a
 *   user edit and never matches.
 *
 * The final hatch-written deviation, `source: "managed"` from the earliest
 * templates, is handled by the caller's source normalization.
 */
function hatchBodyVariants(
  known: Record<string, unknown>,
  key: DefaultProfileKey,
  copyProvider: string,
): Record<string, unknown>[] {
  let variants = [known];
  if (key === "quality-optimized") {
    variants = variants.flatMap((v) => [v, { ...v, effort: "max" }]);
  }
  return variants.flatMap((v) => {
    const { provider_connection: _pc, ...bare } = v;
    return [v, bare, { ...v, provider_connection: copyProvider }];
  });
}

/**
 * Run a body through the exact completion `ensureCompleteCustomProfiles`
 * (custom-profile-ensure.ts) bakes onto every user-source profile each boot,
 * so a copy whose absent-field defaults are already baked onto disk compares
 * equal to the template put through the same completion (and a not-yet-baked
 * copy compares equal too, since both sides normalize). A body completion
 * never touches is returned as-is.
 */
function withCompletionBaked(
  body: Record<string, unknown>,
  base: LLMConfigBase | undefined,
): Record<string, unknown> {
  if (base === undefined) {
    return body;
  }
  return completedProfileBody(body, base) ?? body;
}

/**
 * Label/status the user set on an otherwise-unedited copy. The hatch wrote
 * the template label (suffixed with `ERA_COPY_LABEL_SUFFIX` in the earliest
 * era) and never wrote `status`, so any other label or any `status` key is
 * user state; it survives conversion as the thin managed overlay on the
 * bare key (the `WORKSPACE_OWNED_DEFAULT_FIELDS` overlay in
 * default-profile-catalog.ts). A carried `status: "disabled"` keeps the
 * profile LISTING honest (the picker shows the default disabled) while
 * dispatch is unaffected: the resolver overrides persisted disabled stubs on
 * default keys so the code-owned anchors always resolve (see
 * `providerAwareEntry` in config/llm-resolver.ts).
 */
function userOverlayState(
  entry: Record<string, unknown>,
  key: DefaultProfileKey,
): Record<string, unknown> | null {
  const overlay: Record<string, unknown> = {};
  const templateLabel = USER_PROFILE_TEMPLATES[`custom-${key}`]?.label;
  const hatchWroteLabel =
    entry.label === templateLabel ||
    (templateLabel !== undefined &&
      entry.label === templateLabel + ERA_COPY_LABEL_SUFFIX);
  if ("label" in entry && !hatchWroteLabel) {
    overlay.label = entry.label;
  }
  if ("status" in entry) {
    overlay.status = entry.status;
  }
  return Object.keys(overlay).length > 0 ? overlay : null;
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

/**
 * Advisor fallback order, mirroring the managed list `seedInferenceProfiles`
 * repairs from.
 */
const ADVISOR_FALLBACK_ORDER = [
  "quality-optimized",
  "balanced",
  "cost-optimized",
] as const;

/**
 * `seedInferenceProfiles` runs earlier in boot, so its advisor/active repair
 * judged the pre-conversion state: on the conversion boot it can have
 * dropped `llm.advisorProfile` outright (every default was still a disabled
 * stub when it looked). Re-validate both references against the
 * post-conversion state so the repair lands in the same write instead of a
 * boot late.
 */
function repairProfileSelections(
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
  defaultProvider: DefaultProviderConfig,
  carriedDisables: ReadonlySet<DefaultProfileKey>,
): void {
  const effectiveEntry = (name: string): ProfileEntry | undefined =>
    resolveDefaultProfileForProvider(
      profiles as Record<string, ProfileEntry>,
      name,
      defaultProvider,
    );

  const advisor = llm.advisorProfile;
  const advisorEntry =
    typeof advisor === "string" ? effectiveEntry(advisor) : undefined;
  const advisorUnusable =
    advisorEntry === undefined ||
    (advisorEntry.source === "managed" && advisorEntry.status === "disabled");
  if (advisorUnusable) {
    // A default key whose surviving workspace entry is a disabled managed
    // stub still dispatches the pure catalog body (`providerAwareEntry` in
    // llm-resolver.ts treats such stubs as stale hatch-era state), so it is
    // a better advisor than a lower class whose stub happens to be gone.
    // Judge usability by dispatch semantics, EXCEPT for a disable this very
    // write carried off the user's retired copy: that one is user intent,
    // not hatch residue, and the advisor must not land on it.
    const fallback = ADVISOR_FALLBACK_ORDER.find((key) => {
      const entry = effectiveEntry(key);
      if (entry === undefined) {
        return false;
      }
      if (entry.status !== "disabled") {
        return true;
      }
      if (carriedDisables.has(key)) {
        return false;
      }
      const workspace = readObject(profiles[key]);
      return (
        workspace !== null &&
        workspace.source === "managed" &&
        resolveDefaultProfileForProvider(undefined, key, defaultProvider)
          ?.status !== "disabled"
      );
    });
    if (fallback !== undefined) {
      llm.advisorProfile = fallback;
    }
  }

  const active = llm.activeProfile;
  if (typeof active === "string" && effectiveEntry(active) === undefined) {
    llm.activeProfile = "balanced";
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
