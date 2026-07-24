import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import { isModelInCatalog } from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import type { ModelIntent } from "../providers/types.js";
import { getManagedUpstream } from "../providers/vellum-model-routing.js";
import {
  DEFAULT_PROFILE_KEYS,
  DEFAULT_PROFILE_PROVIDERS,
  type DefaultProfileKey,
  type DefaultProfileProvider,
  INTERNAL_PROFILE_KEYS,
  type InternalProfileKey,
  OS_BETA_PROFILE_KEY,
  PROFILE_MATRIX_KEYS,
  type ProfileMatrixKey,
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
};

/**
 * The `vellum` column: platform-managed implementations, stamped
 * `provider: "vellum"` — dispatch derives the upstream from the model.
 * Models are pinned (never intents): the intent tables are keyed by
 * concrete dispatch providers, and the model is what selects the upstream.
 * Overwritten in workspace config on every daemon boot so Vellum can push
 * model/config updates to customers in new releases.
 */
const VELLUM_PROFILE_IMPLS: Record<ProfileMatrixKey, DefaultProfileTemplate> = {
  balanced: {
    model: "accounts/fireworks/models/glm-5p2",
    provider: "vellum",
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
    model: "claude-fable-5",
    provider: "vellum",
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
    provider: "vellum",
    source: "managed",
    label: "Speed",
    description: "Fastest responses at lower cost (DeepSeek V4 Flash)",
    maxTokens: 8192,
    // Explicit reasoning opt-out. OpenAI-compat APIs default reasoning to
    // "medium" when the field is omitted, and effort-driven providers encode
    // disabled thinking through this same knob (see
    // DISABLED_THINKING_USES_EFFORT_PROVIDERS in providers/retry.ts).
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
  "latency-optimized": {
    // The managed latency class. `cost-optimized`'s upstream showed
    // multi-second cross-session TTFT tails on live voice drives, which the
    // front model's leading tokens cannot absorb — they ARE the turn-taking
    // verdict. Replace only with a model whose managed credentials are
    // provisioned in every environment.
    model: "claude-haiku-4-5-20251001",
    provider: "vellum",
    source: "managed",
    label: "Latency",
    description: "Lowest time-to-first-token, for real-time call sites",
    maxTokens: 8192,
    effort: "low",
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
 * is stamped per column (and overridden at hatch time with the user's
 * chosen provider).
 */
const BYOK_PROFILE_IMPLS: Record<
  ProfileMatrixKey,
  Omit<DefaultProfileTemplate, "provider">
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
  "latency-optimized": {
    intent: "latency-optimized",
    source: "user",
    label: "Latency",
    description: "Lowest time-to-first-token, for real-time call sites",
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
  ProfileMatrixKey,
  Record<DefaultProfileProvider, DefaultProfileTemplate>
> = Object.fromEntries(
  PROFILE_MATRIX_KEYS.map((key) => [
    key,
    Object.fromEntries(
      DEFAULT_PROFILE_PROVIDERS.map((provider) => [
        provider,
        provider === "vellum"
          ? VELLUM_PROFILE_IMPLS[key]
          : { ...BYOK_PROFILE_IMPLS[key], provider },
      ]),
    ) as Record<DefaultProfileProvider, DefaultProfileTemplate>,
  ]),
) as Record<
  ProfileMatrixKey,
  Record<DefaultProfileProvider, DefaultProfileTemplate>
>;

/**
 * Managed profiles, i.e. the `vellum` column keyed by profile name. Seeded
 * into workspace config on every daemon boot; platform overlays
 * (`preserveProfileNames`) take precedence when present. Keyed by the
 * user-facing defaults only — an internal profile is code-resolved and never
 * materialized into workspace config.
 */
export const MANAGED_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [key, PROFILE_IMPLS[key].vellum]),
  );

/**
 * User profile templates, materialized as `custom-*` at hatch time for
 * off-platform installations. The `provider` field is a placeholder — it is
 * overridden at hatch time with the user's chosen provider and personal
 * connection name.
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
  model: "MiniMaxAI/MiniMax-M3",
  provider: "vellum",
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
  ...INTERNAL_PROFILE_KEYS,
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
  ...INTERNAL_PROFILE_KEYS,
  OS_BETA_PROFILE_KEY,
]);

/**
 * Materialize a template into a concrete `ProfileEntry`: resolve `intent` to
 * a model id for the given provider and stamp the provider connection.
 * Routing-identity providers ("vellum") never receive a connection stamp —
 * dispatch resolves their row per-request from the provider value.
 */
export function materializeProfile(
  template: DefaultProfileTemplate,
  provider: NonNullable<ProfileEntry["provider"]>,
  connectionName?: string,
): ProfileEntry {
  const { intent, model, provider: _p, ...rest } = template;
  const resolvedModel =
    model ?? (intent ? resolveModelIntent(provider, intent) : undefined);
  if (!resolvedModel) {
    throw new Error("DefaultProfileTemplate requires `intent` or `model`");
  }
  const stampConnection =
    connectionName && !ROUTING_IDENTITY_PROVIDERS.has(provider);
  return {
    ...rest,
    provider,
    ...(stampConnection ? { provider_connection: connectionName } : {}),
    model: resolvedModel,
  };
}

// ── Consistency validation ───────────────────────────────────────────
// Eagerly verify every implementation at module-load time (mirroring
// `PROVIDER_MODEL_INTENTS`' own check): exactly one of `intent`/`model` is
// set, and every pinned model id exists in PROVIDER_CATALOG for its
// underlying provider — catching drift when a model is renamed or removed.
for (const key of PROFILE_MATRIX_KEYS) {
  for (const provider of DEFAULT_PROFILE_PROVIDERS) {
    const impl = PROFILE_IMPLS[key][provider];
    if ((impl.model == null) === (impl.intent == null)) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] must set exactly one of \`intent\` or \`model\`.`,
      );
    }
    if (impl.provider === "vellum" && impl.model == null) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] must pin a \`model\`: the vellum ` +
          `column has no intent table, and the model selects the upstream.`,
      );
    }
    if (impl.model != null) {
      const routable =
        impl.provider === "vellum"
          ? getManagedUpstream(impl.model) !== null
          : isModelInCatalog(impl.provider, impl.model);
      if (!routable) {
        throw new Error(
          `PROFILE_IMPLS[${key}][${provider}] references model "${impl.model}" ` +
            `which is not ${impl.provider === "vellum" ? "served by any managed upstream" : `in PROVIDER_CATALOG for provider "${impl.provider}"`}. ` +
            `Update model-catalog.ts or default-profile-catalog.ts.`,
        );
      }
    }
  }
}

function buildDefaultProfileEntries(): Record<string, ProfileEntry> {
  const entries: Record<string, ProfileEntry> = {};
  for (const key of PROFILE_MATRIX_KEYS) {
    const impl = PROFILE_IMPLS[key].vellum;
    entries[key] = materializeProfile(impl, impl.provider);
  }
  entries[OS_BETA_PROFILE_KEY] = materializeProfile(
    OS_BETA_PROFILE_TEMPLATE,
    OS_BETA_PROFILE_TEMPLATE.provider,
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
  // An internal profile's body is code-owned outright — no workspace overlay,
  // not even a user-owned shadow. The shadow rule below exists so a user can
  // deliberately replace a default they can see and select; an internal name
  // was never selectable, so a same-named workspace entry (legal before the
  // name was reserved) is unrelated state, not an override. Honoring it would
  // silently hand a latency-class call site an arbitrary user model. The
  // entry itself is untouched: it stays in `llm.profiles`, stays listed, and
  // stays valid as an `activeProfile` reference.
  if (isInternalProfileKey(name)) {
    return { ...body };
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
 * Like `getEffectiveProfile`, but a default profile key's code-owned body
 * comes from the default provider's column of the intent × provider matrix
 * instead of always the `vellum` column. A `null` defaultProvider and every
 * non-matrix name fall back to `getEffectiveProfile`'s behavior.
 *
 * Non-obvious rules:
 *
 * - The `vellum` column stamps `provider: "vellum"` with no connection —
 *   dispatch derives the upstream from the model per-request.
 * - The resolved body carries `source: "managed"` regardless of column:
 *   default profile content is code-owned whichever provider implements it.
 *   The BYOK templates' `source: "user"` is hatch-time state for
 *   materialized `custom-*` copies, not an ownership claim on the body.
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

export function isDefaultProfileKey(name: string): name is DefaultProfileKey {
  return (DEFAULT_PROFILE_KEYS as readonly string[]).includes(name);
}

/**
 * Whether a name is implemented by the intent × provider matrix — the
 * user-facing defaults plus the internal call-site-only profiles. This is the
 * predicate resolution uses: an internal profile must resolve through the
 * default provider's column exactly like a default, even though it is never
 * listed or seeded.
 */
export function isMatrixProfileKey(name: string): name is ProfileMatrixKey {
  return (PROFILE_MATRIX_KEYS as readonly string[]).includes(name);
}

/** Whether a name is a code-owned profile that must never be listed to users. */
export function isInternalProfileKey(name: string): name is InternalProfileKey {
  return (INTERNAL_PROFILE_KEYS as readonly string[]).includes(name);
}

function defaultProfileBodyForProvider(
  name: string,
  defaultProvider: DefaultProviderConfig | null,
): ProfileEntry | undefined {
  if (defaultProvider == null || !isMatrixProfileKey(name)) {
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
 *
 * Internal profiles are omitted: they exist only to be named by a call-site
 * default, so listing them would offer them as selectable models and let
 * `activeProfile`/`overrideProfile` validation accept them. Resolution
 * reaches them by name through `resolveDefaultProfileForProvider`, which
 * does not go through this record.
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
    if (isInternalProfileKey(name)) {
      continue;
    }
    const entry = getEffectiveProfile(workspaceProfiles, name, catalogEntries);
    if (entry != null) {
      effective[name] = entry;
    }
  }
  return effective;
}

/**
 * Like `getEffectiveProfiles`, but resolves each default profile key through
 * the same `llm.defaultProvider`-aware path the runtime resolver uses
 * (`resolveDefaultProfileForProvider`) rather than always the `vellum` column.
 * On BYOK installs this is what makes the reported provider/model/availability
 * for `balanced`/`quality-optimized`/`cost-optimized` match what actually runs.
 * A `null` defaultProvider reduces to `getEffectiveProfiles`.
 */
export function getEffectiveProfilesForProvider(
  workspaceProfiles: Record<string, ProfileEntry> | undefined,
  defaultProvider: DefaultProviderConfig | null,
): Record<string, ProfileEntry> {
  const effective: Record<string, ProfileEntry> = {
    ...(workspaceProfiles ?? {}),
  };
  for (const name of Object.keys(CODE_DEFAULT_PROFILE_ENTRIES)) {
    if (isInternalProfileKey(name)) {
      continue;
    }
    const entry = resolveDefaultProfileForProvider(
      workspaceProfiles,
      name,
      defaultProvider,
    );
    if (entry != null) {
      effective[name] = entry;
    }
  }
  return effective;
}
