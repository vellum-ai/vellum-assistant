import { isModelInCatalog } from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { VELLUM_MANAGED_CONNECTION_NAME } from "../providers/vellum-model-routing.js";
import {
  DEFAULT_PROFILE_KEYS,
  DEFAULT_PROFILE_PROVIDERS,
  type DefaultProfileKey,
  type DefaultProfileProvider,
  OS_BETA_PROFILE_KEY,
} from "./default-profile-names.js";
import { resolveDefaultConnectionName } from "./default-provider-resolution.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  type DefaultProviderConfig,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Code-defined catalog of the default inference profiles (`balanced`,
 * `quality-optimized`, `cost-optimized`, plus the flag-gated `os-beta`).
 *
 * The catalog is the single source of truth for default profile CONTENT,
 * structured as an intent × provider matrix: each default profile is an
 * intent, and each provider that can serve default profiles has a concrete
 * implementation of that intent (model, token budget, effort, thinking).
 * The `vellum` column is the platform-managed implementation; the other
 * columns are the BYOK implementations used to materialize the personal
 * `custom-*` profiles at hatch time.
 *
 * `seedInferenceProfiles` still materializes the `vellum` column into
 * workspace config on every boot, but runtime readers resolve profiles
 * through `getEffectiveProfiles`/`getEffectiveProfile` below, which serve
 * default bodies from this module and overlay only the workspace-owned
 * `label`/`status`/`topP` state. This keeps default profile content
 * updatable by shipping a release — no workspace migration.
 */

/**
 * Template for a default (code-owned) inference profile implementation.
 * Exactly one of `intent` or `model` must be set: `intent` resolves the
 * model from `PROVIDER_MODEL_INTENTS` at materialization time; `model` pins
 * an explicit model id.
 */
export type DefaultProfileTemplate = Omit<
  ProfileEntry,
  "provider" | "model" | "provider_connection"
> & {
  intent?: ModelIntent;
  model?: string;
  provider: NonNullable<ProfileEntry["provider"]>;
  connectionName: string;
};

/**
 * The `vellum` column: platform-managed implementations. Overwritten in
 * workspace config on every daemon boot so Vellum can push model/config
 * updates to customers in new releases.
 */
const VELLUM_PROFILE_IMPLS: Record<DefaultProfileKey, DefaultProfileTemplate> =
  {
    balanced: {
      model: "accounts/fireworks/models/glm-5p2",
      provider: "fireworks",
      connectionName: VELLUM_MANAGED_CONNECTION_NAME,
      source: "managed",
      label: "Balanced",
      description: "Good balance of quality, cost, and speed",
      maxTokens: 32000,
      effort: "high",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: {
        maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
      },
    },
    "quality-optimized": {
      intent: "quality-optimized",
      provider: "anthropic",
      connectionName: VELLUM_MANAGED_CONNECTION_NAME,
      source: "managed",
      label: "Quality",
      description: "High-quality results with the most capable model",
      maxTokens: 32000,
      effort: "high",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: {
        maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
      },
    },
    "cost-optimized": {
      model: "accounts/fireworks/models/deepseek-v4-flash",
      provider: "fireworks",
      connectionName: VELLUM_MANAGED_CONNECTION_NAME,
      source: "managed",
      label: "Speed",
      description: "Fastest responses at lower cost (DeepSeek V4 Flash)",
      maxTokens: 8192,
      // Not "low": Fireworks strips the disabled `thinking` config but would
      // still send a non-"none" effort as `reasoning_effort`, making this
      // profile pay for reasoning despite thinking being off.
      effort: "none",
      thinking: { enabled: false, streamThinking: false },
      contextWindow: {
        maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
      },
    },
  };

/**
 * The BYOK implementation of each default profile intent, shared by every
 * non-vellum provider column. The concrete model resolves per provider from
 * the `intent` via `resolveModelIntent` at materialization time. `provider`
 * and `connectionName` are stamped per column (and overridden at hatch time
 * with the user's chosen provider and personal connection).
 */
const BYOK_PROFILE_IMPLS: Record<
  DefaultProfileKey,
  Omit<DefaultProfileTemplate, "provider" | "connectionName">
> = {
  balanced: {
    intent: "balanced",
    source: "user",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "quality-optimized": {
    intent: "quality-optimized",
    source: "user",
    label: "Quality",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "cost-optimized": {
    intent: "latency-optimized",
    source: "user",
    label: "Speed",
    description: "Fastest responses at lower cost",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
};

/**
 * The intent × provider matrix: `PROFILE_IMPLS[key][provider]` is the full
 * implementation of default profile `key` on `provider`.
 */
export const PROFILE_IMPLS: Record<
  DefaultProfileKey,
  Record<DefaultProfileProvider, DefaultProfileTemplate>
> = Object.fromEntries(
  DEFAULT_PROFILE_KEYS.map((key) => [
    key,
    Object.fromEntries(
      DEFAULT_PROFILE_PROVIDERS.map((provider) => [
        provider,
        provider === "vellum"
          ? VELLUM_PROFILE_IMPLS[key]
          : { ...BYOK_PROFILE_IMPLS[key], provider, connectionName: "" },
      ]),
    ) as Record<DefaultProfileProvider, DefaultProfileTemplate>,
  ]),
) as Record<
  DefaultProfileKey,
  Record<DefaultProfileProvider, DefaultProfileTemplate>
>;

/**
 * Managed profiles, i.e. the `vellum` column keyed by profile name. Seeded
 * into workspace config on every daemon boot; platform overlays
 * (`preserveProfileNames`) take precedence when present.
 */
export const MANAGED_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [key, PROFILE_IMPLS[key].vellum]),
  );

/**
 * User profile templates, materialized as `custom-*` at hatch time for
 * off-platform installations. The `provider` and `connectionName` fields are
 * placeholders — they are overridden at hatch time with the user's chosen
 * provider and personal connection name.
 */
export const USER_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [
      `custom-${key}`,
      PROFILE_IMPLS[key].anthropic,
    ]),
  );

/**
 * Flag-gated managed profile. NOT in `MANAGED_PROFILE_TEMPLATES`, so the
 * unconditional boot seed never creates it. Reconciled in/out by
 * the flag-gated profile reconcile based on the `os-beta` feature flag.
 * Balanced defaults, with lower reasoning effort while the profile is in beta.
 */
export const OS_BETA_PROFILE_TEMPLATE: DefaultProfileTemplate = {
  intent: "balanced",
  provider: "together",
  connectionName: VELLUM_MANAGED_CONNECTION_NAME,
  source: "managed",
  label: "OS Beta",
  description: "Good balance of quality, cost, and speed, in beta",
  maxTokens: 32000,
  effort: "low",
  thinking: { enabled: true, streamThinking: true },
  contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  topP: 0.95,
};

// All managed profiles, including the flag-gated os-beta, are invariant:
// their MANAGED-SOURCE entries are read-only to user-facing writes except
// re-enabling a disabled one (enforced at commitConfigWrite). A user-owned
// profile sharing one of these names is NOT locked — invariance is gated on
// the on-disk entry's `source` being `managed`.
export const INVARIANT_PROFILE_NAMES = new Set<string>([
  ...DEFAULT_PROFILE_KEYS,
  OS_BETA_PROFILE_KEY,
]);

// Membership here marks a name as managed. The route layer applies managed
// restrictions (blocking model/provider edits and deletion) only to entries
// whose on-disk `source` is `managed`; `INVARIANT_PROFILE_NAMES` marks the
// names whose managed-source entries are additionally frozen at the
// `commitConfigWrite` choke point. `OS_BETA_PROFILE_KEY` is flag-gated: it is
// materialized by the flag-gated profile reconcile, which refuses to touch a
// same-named user profile.
export const MANAGED_PROFILE_NAMES = new Set<string>([
  ...DEFAULT_PROFILE_KEYS,
  OS_BETA_PROFILE_KEY,
]);

/**
 * Materialize a template into a concrete `ProfileEntry`: resolve `intent` to
 * a model id for the given provider and stamp the provider connection.
 */
export function materializeProfile(
  template: DefaultProfileTemplate,
  provider: NonNullable<ProfileEntry["provider"]>,
  connectionName: string,
): ProfileEntry {
  const { intent, model, provider: _p, connectionName: _c, ...rest } = template;
  const resolvedModel =
    model ?? (intent ? resolveModelIntent(provider, intent) : undefined);
  if (!resolvedModel) {
    throw new Error("DefaultProfileTemplate requires `intent` or `model`");
  }
  return {
    ...rest,
    provider,
    provider_connection: connectionName,
    model: resolvedModel,
  };
}

// ── Consistency validation ───────────────────────────────────────────
// Eagerly verify every implementation at module-load time (mirroring
// `PROVIDER_MODEL_INTENTS`' own check): exactly one of `intent`/`model` is
// set, and every pinned model id exists in PROVIDER_CATALOG for its
// underlying provider — catching drift when a model is renamed or removed.
for (const key of DEFAULT_PROFILE_KEYS) {
  for (const provider of DEFAULT_PROFILE_PROVIDERS) {
    const impl = PROFILE_IMPLS[key][provider];
    if ((impl.model == null) === (impl.intent == null)) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] must set exactly one of \`intent\` or \`model\`.`,
      );
    }
    if (impl.model != null && !isModelInCatalog(impl.provider, impl.model)) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] references model "${impl.model}" ` +
          `which is not in PROVIDER_CATALOG for provider "${impl.provider}". ` +
          `Update model-catalog.ts or default-profile-catalog.ts.`,
      );
    }
  }
}

function buildDefaultProfileEntries(): Record<string, ProfileEntry> {
  const entries: Record<string, ProfileEntry> = {};
  for (const key of DEFAULT_PROFILE_KEYS) {
    const impl = PROFILE_IMPLS[key].vellum;
    entries[key] = materializeProfile(impl, impl.provider, impl.connectionName);
  }
  entries[OS_BETA_PROFILE_KEY] = materializeProfile(
    OS_BETA_PROFILE_TEMPLATE,
    OS_BETA_PROFILE_TEMPLATE.provider,
    OS_BETA_PROFILE_TEMPLATE.connectionName,
  );
  return entries;
}

/**
 * The materialized code-default bodies keyed by profile name — the
 * code-owned content a managed-source workspace entry resolves to. These are
 * the `vellum` column (the managed implementations).
 */
export const CODE_DEFAULT_PROFILE_ENTRIES: Readonly<
  Record<string, ProfileEntry>
> = buildDefaultProfileEntries();

/**
 * The per-default-profile fields that remain workspace-owned state: the
 * exact whitelist `seedInferenceProfiles` preserves across reseeds (BYOK
 * label suffix, hatch-time/user disable, pre-existing topP overrides).
 * Carried by key-presence rather than truthiness so an explicit `null`
 * (cleared field) survives too.
 */
const WORKSPACE_OWNED_DEFAULT_FIELDS = ["label", "status", "topP"] as const;

/**
 * Resolve a single profile name against the effective catalog: code-defined
 * default bodies overlaid with workspace-owned state, plus workspace-defined
 * custom profiles.
 *
 * Precedence:
 * - A name with no code default resolves to the workspace entry (custom
 *   profiles pass through untouched).
 * - A workspace entry whose `source` is not `managed` wins over the code
 *   default — a user-owned profile sharing a default name shadows it.
 * - A managed-source workspace entry contributes only its
 *   `WORKSPACE_OWNED_DEFAULT_FIELDS`; all other content comes from the code
 *   default body.
 * - A default absent from the workspace resolves to the catalog body as-is —
 *   the workspace holds at most a thin stub for a default, never its
 *   content. The flag-gated `os-beta` is the exception: it resolves only
 *   while the flag reconcile has materialized a workspace entry for it.
 */
export function getEffectiveProfile(
  workspaceProfiles: Record<string, ProfileEntry> | undefined,
  name: string,
  catalogEntries: Readonly<
    Record<string, ProfileEntry>
  > = CODE_DEFAULT_PROFILE_ENTRIES,
): ProfileEntry | undefined {
  return resolveAgainstBody(
    workspaceProfiles?.[name],
    name,
    catalogEntries[name],
  );
}

/**
 * The shared workspace-overlay step of effective-profile resolution: given
 * the workspace entry for a name and the code-owned body that name resolves
 * to, apply the precedence documented on `getEffectiveProfile`.
 */
function resolveAgainstBody(
  workspace: ProfileEntry | undefined,
  name: string,
  body: ProfileEntry | undefined,
): ProfileEntry | undefined {
  if (body == null) {
    return workspace;
  }
  if (workspace == null) {
    return name === OS_BETA_PROFILE_KEY ? undefined : { ...body };
  }
  if (workspace.source !== "managed") {
    return workspace;
  }
  const merged: ProfileEntry = { ...body };
  for (const field of WORKSPACE_OWNED_DEFAULT_FIELDS) {
    if (field in workspace) {
      (merged as Record<string, unknown>)[field] = workspace[field];
    }
  }
  return merged;
}

/**
 * Resolve a default-profile intent through the workspace's default provider:
 * like `getEffectiveProfile`, but the code-owned body for a default profile
 * key comes from that provider's column of the intent × provider matrix
 * instead of always the `vellum` column.
 *
 * - The body's connection is `resolveDefaultConnectionName(defaultProvider)`
 *   (an explicit `connectionName` wins; `vellum` maps to the managed
 *   connection; BYOK maps to `${provider}-personal`). For the `vellum`
 *   column the stamped provider stays the column's underlying provider
 *   (e.g. `fireworks` for `balanced`) — `vellum` is a routing identity, not
 *   a dispatch provider.
 * - The resolved body carries `source: "managed"` regardless of column:
 *   default profile content is code-owned whichever provider implements it.
 *   (The BYOK templates' `source: "user"` is hatch-time state for
 *   materialized `custom-*` copies, not an ownership claim on the catalog
 *   body.)
 * - Workspace precedence is identical to `getEffectiveProfile`: a
 *   user-source workspace entry shadows the default outright; a
 *   managed-source stub contributes only `label`/`status`/`topP`.
 * - A `null` defaultProvider (defensive: M5 guarantees the field post-boot)
 *   and every non-matrix name (custom profiles, `os-beta`) fall back to
 *   `CODE_DEFAULT_PROFILE_ENTRIES` — exactly `getEffectiveProfile`'s
 *   behavior.
 *
 * No runtime consumers yet: the M6 override-or-default resolver adopts this
 * as the call-site default-intent lookup.
 */
export function resolveDefaultProfileForProvider(
  workspaceProfiles: Record<string, ProfileEntry> | undefined,
  name: string,
  defaultProvider: DefaultProviderConfig | null,
): ProfileEntry | undefined {
  return resolveAgainstBody(
    workspaceProfiles?.[name],
    name,
    defaultProfileBodyForProvider(name, defaultProvider),
  );
}

function isDefaultProfileKey(name: string): name is DefaultProfileKey {
  return (DEFAULT_PROFILE_KEYS as readonly string[]).includes(name);
}

function defaultProfileBodyForProvider(
  name: string,
  defaultProvider: DefaultProviderConfig | null,
): ProfileEntry | undefined {
  if (defaultProvider == null || !isDefaultProfileKey(name)) {
    return CODE_DEFAULT_PROFILE_ENTRIES[name];
  }
  const impl = PROFILE_IMPLS[name][defaultProvider.provider];
  return {
    ...materializeProfile(
      impl,
      impl.provider,
      resolveDefaultConnectionName(defaultProvider),
    ),
    source: "managed",
  };
}

/**
 * The full effective profile record: every workspace profile plus every
 * available code default, merged per `getEffectiveProfile`. This is the
 * record all runtime readers of `llm.profiles` should consume; the raw
 * workspace record is a write-path concern.
 */
export function getEffectiveProfiles(
  workspaceProfiles: Record<string, ProfileEntry> | undefined,
  catalogEntries: Readonly<
    Record<string, ProfileEntry>
  > = CODE_DEFAULT_PROFILE_ENTRIES,
): Record<string, ProfileEntry> {
  const effective: Record<string, ProfileEntry> = {
    ...(workspaceProfiles ?? {}),
  };
  for (const name of Object.keys(catalogEntries)) {
    const entry = getEffectiveProfile(workspaceProfiles, name, catalogEntries);
    if (entry != null) {
      effective[name] = entry;
    }
  }
  return effective;
}
