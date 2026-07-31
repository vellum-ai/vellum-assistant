import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import {
  catalogMaxOutputTokens,
  isModelInCatalog,
} from "../providers/model-catalog.js";
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
  isDefaultProfileProvider,
  OS_BETA_PROFILE_KEY,
  PROFILE_MATRIX_KEYS,
  type ProfileMatrixKey,
} from "./default-profile-names.js";
import { resolveDefaultConnectionName } from "./default-provider-resolution.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  DEFAULT_PROVIDER_CHOICES,
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
 * columns are the BYOK implementations resolved through `llm.defaultProvider`
 * on off-platform installs.
 *
 * Nothing materializes default bodies into workspace config: runtime readers
 * resolve profiles through `getEffectiveProfiles`/`getEffectiveProfile`
 * below, which serve default bodies from this module and overlay only the
 * workspace-owned `label`/`status`/`topP` state. This keeps default profile
 * content updatable by shipping a release, with no workspace migration.
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
    model: "gpt-5.6-sol",
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
    // Tier intent only - never name the concrete model here. Clients
    // surface the live model beside the description, so a model name in
    // this copy would go stale the moment the pin moves.
    description: "Fastest responses at lower cost",
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
    // The managed latency class. Its leading tokens are the live-voice
    // turn-taking verdict, so what this profile optimizes is the tail of
    // time-to-first-token rather than the median: a verdict slower than
    // `liveVoice.frontModel.endpointDecisionTimeoutMs` trips the speculative
    // fail-open commit in live-voice-session.ts, which is audible dead air.
    //
    // Two constraints bind the model id. Its managed credentials must be
    // provisioned in every environment, and it alone selects the upstream:
    // `provider` below is the provider-agnostic managed sentinel, so
    // `getManagedUpstream` resolves the real upstream from the model's catalog
    // owner.
    model: "gpt-5.6-luna",
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
 * non-vellum provider. The concrete model resolves per provider from the
 * `intent` via `resolveModelIntent` at materialization time (falling back to
 * the provider's catalog `defaultModel` when it has no intent table).
 * `provider` is stamped per column for the named matrix columns, and
 * per-request for any other default-capable provider.
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
 * Managed profiles, i.e. the `vellum` column keyed by profile name. Keyed by
 * the user-facing defaults only: an internal profile is code-resolved and
 * never listed or ordered.
 */
export const MANAGED_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [key, PROFILE_IMPLS[key].vellum]),
  );

/**
 * Frozen record of the `custom-*` profile bodies that pre-conversion BYOK
 * hatches wrote to workspace config (the anthropic column; provider and
 * connection were overridden per hatch). Consumed by the existing-install
 * conversion pass as the reference for recognizing unedited copies, which
 * are safe to remove in favor of the code-resolved defaults.
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

// Provider choices without a named column materialize from the shared BYOK
// templates; verify each one's resolved model lands in the catalog.
for (const provider of DEFAULT_PROVIDER_CHOICES) {
  if (isDefaultProfileProvider(provider)) {
    continue;
  }
  for (const key of PROFILE_MATRIX_KEYS) {
    const { model } = materializeProfile(
      { ...BYOK_PROFILE_IMPLS[key], provider },
      provider,
    );
    if (model == null || !isModelInCatalog(provider, model)) {
      throw new Error(
        `Default provider choice "${provider}" cannot materialize "${key}": ` +
          `resolved model "${model ?? ""}" is not in PROVIDER_CATALOG. ` +
          `Update model-catalog.ts or model-intents.ts.`,
      );
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
 * exact whitelist `seedInferenceProfiles` preserves across reseeds (user
 * renames, user disables, topP overrides). Carried by key-presence rather
 * than truthiness so an explicit `null` (cleared field) survives too.
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
 * comes from the default provider's implementation of the intent × provider
 * matrix instead of always the `vellum` column. A `null` defaultProvider and
 * every non-matrix name fall back to `getEffectiveProfile`'s behavior.
 *
 * Non-obvious rules:
 *
 * - The `vellum` column stamps `provider: "vellum"` with no connection —
 *   dispatch derives the upstream from the model per-request.
 * - A default provider without a named matrix column materializes from the
 *   shared `BYOK_PROFILE_IMPLS` templates, with `resolveModelIntent`
 *   falling back to the provider's catalog `defaultModel`.
 * - The resolved body carries `source: "managed"` regardless of provider:
 *   default profile content is code-owned whichever provider implements it.
 *   The BYOK templates' `source: "user"` exists for the conversion pass's
 *   frozen `custom-*` reference bodies (`USER_PROFILE_TEMPLATES`), not as
 *   an ownership claim on the body.
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
  const { provider } = defaultProvider;
  const impl = isDefaultProfileProvider(provider)
    ? PROFILE_IMPLS[name][provider]
    : { ...BYOK_PROFILE_IMPLS[name], provider };
  return clampMaxTokensToModelCap({
    ...materializeProfile(
      impl,
      impl.provider,
      resolveDefaultConnectionName(defaultProvider),
    ),
    source: "managed",
  });
}

/**
 * Clamp a code-owned default body's `maxTokens` to the resolved model's
 * catalog `maxOutputTokens`. The shared BYOK templates request one token
 * budget per intent, but the model a provider resolves can allow less
 * (e.g. atlascloud caps output at 8192 while the balanced template asks for
 * 16000), and an over-cap request is rejected upstream. The `vellum` column
 * is exempt by construction: "vellum" is not a catalog provider, so the
 * lookup misses and the hand-validated managed pins pass through untouched.
 * User-authored profiles never reach this path.
 */
function clampMaxTokensToModelCap(body: ProfileEntry): ProfileEntry {
  if (body.provider == null || body.model == null || body.maxTokens == null) {
    return body;
  }
  const cap = catalogMaxOutputTokens(body.provider, body.model);
  if (cap == null || body.maxTokens <= cap) {
    return body;
  }
  return { ...body, maxTokens: cap };
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
