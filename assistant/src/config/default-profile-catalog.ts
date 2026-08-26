import { ROUTING_IDENTITY_PROVIDERS } from "../providers/inference/auth.js";
import {
  catalogMaxOutputTokens,
  isModelInCatalog,
} from "../providers/model-catalog.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import { isCodexSubscriptionModel } from "../providers/openai/codex-models.js";
import type { ModelIntent } from "../providers/types.js";
import { getManagedUpstream } from "../providers/vellum-model-routing.js";
import { getBalancedModelExperimentArm } from "./balanced-model-experiment.js";
import {
  BACKUP_PROFILE_KEYS,
  type BackupProfileKey,
  DEFAULT_PROFILE_KEYS,
  DEFAULT_PROFILE_PROVIDERS,
  type DefaultProfileKey,
  type DefaultProfileProvider,
  FALLBACK_PROFILE_BY_KEY,
  isBackupProfileKey,
  isDefaultProfileKey,
  isDefaultProfileProvider,
  OS_BETA_PROFILE_KEY,
} from "./default-profile-names.js";
import { resolveDefaultConnectionName } from "./default-provider-resolution.js";
import {
  backupProfilesResolveUnderDefaultProvider,
  DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  DEFAULT_PROVIDER_CHOICES,
  type DefaultProviderConfig,
  type ProfileEntry,
} from "./schemas/llm.js";

/**
 * Code-defined catalog of the default inference profiles (`balanced`,
 * `quality-optimized`, `cost-optimized`, `latency-optimized`, plus the
 * flag-gated `os-beta`).
 *
 * The catalog is the single source of truth for default profile CONTENT,
 * structured as an intent × provider matrix: each default profile is an
 * intent, and each provider that can serve default profiles has a concrete
 * implementation of that intent (model, token budget, effort, thinking).
 * The `vellum` column is the platform-managed implementation and the
 * `chatgpt` column is the ChatGPT-subscription implementation; the other
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

/** One implementation of every default profile, keyed by profile key. */
type ProfileImpls = Record<DefaultProfileKey, DefaultProfileTemplate>;

/**
 * The `vellum` column: platform-managed implementations, stamped
 * `provider: "vellum"` — dispatch derives the upstream from the model.
 * Models are pinned (never intents): the intent tables are keyed by
 * concrete dispatch providers, and the model is what selects the upstream.
 * Overwritten in workspace config on every daemon boot so Vellum can push
 * model/config updates to customers in new releases.
 *
 * Each implementation points at its managed backup profile via
 * `fallbackProfile` (`BACKUP_PROFILE_IMPLS` below): a backup pins a model at
 * a different upstream provider, so an outage-type failure at the primary's
 * provider can be served by re-sending on the backup. Vellum column only:
 * the BYOK and chatgpt columns carry no pointers, since those installs may
 * hold no credential for the backup's provider.
 */
const VELLUM_PROFILE_IMPLS: ProfileImpls = {
  balanced: {
    model: "accounts/fireworks/models/glm-5p2",
    provider: "vellum",
    source: "managed",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    fallbackProfile: FALLBACK_PROFILE_BY_KEY.balanced,
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
    fallbackProfile: FALLBACK_PROFILE_BY_KEY["quality-optimized"],
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
  "cost-optimized": {
    model: "accounts/fireworks/models/deepseek-v4-flash-0731",
    provider: "vellum",
    source: "managed",
    label: "Cost",
    // Tier intent only - never name the concrete model here. Clients
    // surface the live model beside the description, so a model name in
    // this copy would go stale the moment the pin moves.
    description: "Cheapest responses, for high-volume work",
    fallbackProfile: FALLBACK_PROFILE_BY_KEY["cost-optimized"],
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
    // The managed latency class, also what the live-voice front model runs on.
    // Its leading tokens are the turn-taking verdict, so what this profile
    // optimizes is the tail of time-to-first-token rather than the median: a
    // verdict slower than `liveVoice.frontModel.endpointDecisionTimeoutMs`
    // trips the speculative fail-open commit in live-voice-session.ts, which
    // is audible dead air.
    //
    // Two constraints bind the model id. Its managed credentials must be
    // provisioned in every environment, and it alone selects the upstream:
    // `provider` below is the provider-agnostic managed sentinel, so
    // `getManagedUpstream` resolves the real upstream from the model's catalog
    // owner. This model is the one live-voice TTFT drives validated.
    model: "gpt-5.6-luna",
    provider: "vellum",
    source: "managed",
    label: "Speed",
    description: "Fastest responses, with reasoning turned off",
    fallbackProfile: FALLBACK_PROFILE_BY_KEY["latency-optimized"],
    maxTokens: 8192,
    // Explicit reasoning opt-out, matching `cost-optimized` above: this
    // profile advertises reasoning as off, and OpenAI-compat APIs default
    // reasoning to "medium" when the field is omitted, so the opt-out has to
    // be stated rather than implied.
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
};

/**
 * The managed backup profiles, one per default profile: the route a primary's
 * `fallbackProfile` pointer names. Vellum column only: backups never
 * materialize for BYOK or chatgpt installs. Like the primaries, models are
 * pinned (never intents) and stamped `provider: "vellum"`, so dispatch
 * derives the upstream from the model. Every backup pins its model at a
 * DIFFERENT upstream provider than its primary (that cross-provider split is
 * the entire point), and the module-load validation below enforces
 * routability.
 *
 * Descriptions name the tier they back, never the concrete model: clients
 * surface the live model beside the description, so a model name in this
 * copy would go stale the moment a pin moves.
 */
const BACKUP_PROFILE_IMPLS: Record<BackupProfileKey, DefaultProfileTemplate> = {
  "balanced-backup": {
    model: "claude-sonnet-5",
    provider: "vellum",
    source: "managed",
    label: "Balanced Backup",
    description: "Automatic backup for the Balanced profile",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
  "quality-optimized-backup": {
    model: "claude-opus-5",
    provider: "vellum",
    source: "managed",
    label: "Quality Backup",
    description: "Automatic backup for the Quality profile",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
  "cost-optimized-backup": {
    model: "gemini-3.1-flash-lite",
    provider: "vellum",
    source: "managed",
    label: "Cost Backup",
    description: "Automatic backup for the Cost profile",
    maxTokens: 8192,
    // Explicit reasoning opt-out, matching the primary Cost profile: OpenAI-
    // compat APIs default reasoning to "medium" when the field is omitted,
    // and effort-driven providers encode disabled thinking through this same
    // knob (see DISABLED_THINKING_USES_EFFORT_PROVIDERS in
    // providers/retry.ts).
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
  "latency-optimized-backup": {
    model: "claude-haiku-4-5-20251001",
    provider: "vellum",
    source: "managed",
    label: "Speed Backup",
    description: "Automatic backup for the Speed profile",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: {
      maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  },
};

/**
 * Arm to managed model pin for the `experiment-balanced-model-2026-08-06` A/B
 * test (`balanced-model-experiment.ts` owns the flag read). An arm repoints
 * the model of the managed (`vellum`) implementation of `balanced` and nothing
 * else: effort, thinking, token budget, label and description all stay on the
 * shipped body, and the `chatgpt` and BYOK columns are untouched because those
 * installs run the provider their user chose and sit outside the experiment.
 *
 * `control` is absent by design. It, an arm this build does not know, and an
 * unset flag all resolve to the shipped body, so no LaunchDarkly value can
 * strand an install on a model that is not pinned here. A `Map` rather than an
 * object literal keeps that true for every string LaunchDarkly can send: the
 * arm is remote input, and an object lookup would resolve `constructor` or
 * `toString` to an inherited `Object.prototype` member instead of missing.
 *
 * `glm-5p2` names the same model as the shipped pin and stays in the table so
 * the arm keeps its meaning if the shipped pin moves again.
 */
const BALANCED_EXPERIMENT_MODELS = new Map<string, string>([
  ["terra", "gpt-5.6-terra"],
  ["glm-5p2", "accounts/fireworks/models/glm-5p2"],
]);

/**
 * The managed (`vellum`) implementation of a default profile, carrying the
 * balanced-model experiment arm. Resolved per call rather than materialized
 * once: the gateway pushes flag changes to a running daemon, so the arm can
 * move under a live process.
 */
function managedProfileImpl(key: DefaultProfileKey): DefaultProfileTemplate {
  const impl = VELLUM_PROFILE_IMPLS[key];
  if (key !== "balanced") {
    return impl;
  }
  const arm = getBalancedModelExperimentArm();
  const model = arm == null ? undefined : BALANCED_EXPERIMENT_MODELS.get(arm);
  return model == null ? impl : { ...impl, model };
}

/**
 * The `chatgpt` column: ChatGPT-subscription implementations, stamped
 * `provider: "chatgpt"` so dispatch routes through the canonical
 * `chatgpt-subscription` row via `resolveRoutingIdentity` with no pinned
 * connection. Models are pinned (never intents): the intent tables are
 * keyed by concrete dispatch providers, and the Codex endpoint serves only
 * `CODEX_SUBSCRIPTION_MODEL_IDS`. Cost and Speed are identical
 * implementations here: the subscription serves no tier cheaper or faster
 * than luna, and both profiles advertise reasoning off.
 */
const CHATGPT_PROFILE_IMPLS: ProfileImpls = {
  balanced: {
    model: "gpt-5.6-luna",
    provider: "chatgpt",
    source: "managed",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    // Matches the vellum column's Balanced token budget: the Codex path
    // sends no max_output_tokens, so this only sizes internal budgeting.
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "quality-optimized": {
    model: "gpt-5.6-sol",
    provider: "chatgpt",
    source: "managed",
    label: "Quality",
    description: "Best results with the most capable model",
    maxTokens: 32000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "cost-optimized": {
    model: "gpt-5.6-luna",
    provider: "chatgpt",
    source: "managed",
    label: "Cost",
    description: "Cheapest responses, for high-volume work",
    maxTokens: 8192,
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "latency-optimized": {
    model: "gpt-5.6-luna",
    provider: "chatgpt",
    source: "managed",
    label: "Speed",
    description: "Fastest responses, with reasoning turned off",
    maxTokens: 8192,
    // Explicit reasoning opt-out, matching the other columns: this profile
    // advertises reasoning as off, and OpenAI-compat APIs default reasoning
    // to "medium" when the field is omitted, so the opt-out has to be stated
    // rather than implied.
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
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
  DefaultProfileKey,
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
  // On providers whose cheapest model is also their fastest (anthropic,
  // ollama, fireworks) these two intents resolve the same model and the split
  // is effort alone (see PROVIDER_MODEL_INTENTS).
  "cost-optimized": {
    intent: "cost-optimized",
    source: "user",
    label: "Cost",
    description: "Cheapest responses, for high-volume work",
    maxTokens: 8192,
    effort: "none",
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS },
  },
  "latency-optimized": {
    intent: "latency-optimized",
    source: "user",
    label: "Speed",
    description: "Fastest responses, with reasoning turned off",
    maxTokens: 8192,
    effort: "none",
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
          : provider === "chatgpt"
            ? CHATGPT_PROFILE_IMPLS[key]
            : { ...BYOK_PROFILE_IMPLS[key], provider },
      ]),
    ) as Record<DefaultProfileProvider, DefaultProfileTemplate>,
  ]),
) as Record<
  DefaultProfileKey,
  Record<DefaultProfileProvider, DefaultProfileTemplate>
>;

/**
 * Managed profiles, i.e. the `vellum` column keyed by profile name, plus the
 * managed backup profiles. Backups come after the primaries, which is what
 * places them after the primaries in the seeded `profileOrder`: the seeder
 * inserts missing managed keys in this record's order. Keyed by the
 * user-facing defaults only: an internal profile is code-resolved and never
 * listed or ordered.
 */
export const MANAGED_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries([
    ...DEFAULT_PROFILE_KEYS.map((key) => [key, PROFILE_IMPLS[key].vellum]),
    ...BACKUP_PROFILE_KEYS.map((key) => [key, BACKUP_PROFILE_IMPLS[key]]),
  ]);

/**
 * The values BYOK hatch seeding wrote onto each `custom-*` copy, for the keys
 * whose live template carries something else. The conversion pass recognizes
 * an unedited copy by comparing it field-by-field against the frozen body, so
 * every field here must describe what sits on disk, not what the profile
 * resolves to today. A field the live template alone supplies makes every
 * unedited copy read as user-edited and stop converting.
 *
 * `intent` selects the copy's model through `materializeProfile`, so it is the
 * load-bearing pin. `label` is compared nowhere in the body, but
 * `userOverlayState` reads it to tell a user rename from the hatch's own
 * label, and a mismatch there carries a phantom rename onto the bare key.
 */
const HATCH_ERA_TEMPLATE_FIELDS: Partial<
  Record<DefaultProfileKey, Partial<DefaultProfileTemplate>>
> = {
  "cost-optimized": {
    intent: "latency-optimized",
    label: "Speed",
    description: "Fastest responses at lower cost",
    effort: "low",
  },
};

/**
 * Frozen record of the `custom-*` profile bodies that pre-conversion BYOK
 * hatches wrote to workspace config (the anthropic column; provider and
 * connection were overridden per hatch). Consumed by the existing-install
 * conversion pass as the reference for recognizing unedited copies, which
 * are safe to remove in favor of the code-resolved defaults.
 *
 * The `latency-optimized` entry exists for shape only: hatch seeding writes no
 * `custom-latency-optimized`, so no install holds one to recognize.
 */
export const USER_PROFILE_TEMPLATES: Record<string, DefaultProfileTemplate> =
  Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [
      `custom-${key}`,
      { ...PROFILE_IMPLS[key].anthropic, ...HATCH_ERA_TEMPLATE_FIELDS[key] },
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

/**
 * Profiles whose body is code-owned outright: no workspace overlay, and no
 * user-owned shadow. The shadow rule below lets a user replace a default they
 * can select, but `latency-optimized` serves `voiceFrontDoor` and
 * `voiceProgressNarration`, where a model outside the latency envelope is
 * audible dead air rather than a slow reply. A same-named
 * workspace entry stays on disk and stays listed; it just never governs what
 * this name resolves to.
 *
 * All four backups carry the same protection rather than only
 * `latency-optimized-backup`. The narrow argument covers that one alone: it
 * serves the live-voice path whenever the primary falls back, so a shadow
 * reintroduces exactly the dead-air risk the primary's protection exists to
 * prevent. The broader argument covers all four, and is why the whole set is
 * here: a backup only earns its place by pinning a model at a different
 * upstream than the primary it backs (see `BACKUP_PROFILE_IMPLS`), and a
 * user-owned shadow can silently repoint it at the primary's own provider,
 * so the fallback re-sends into the outage it exists to route around. A
 * backup also has no per-provider matrix column, so there is nothing a
 * workspace overlay could legitimately own on it.
 */
export const CODE_OWNED_PROFILE_NAMES = new Set<string>([
  "latency-optimized",
  ...BACKUP_PROFILE_KEYS,
]);

// All managed profiles, including the flag-gated os-beta, are invariant:
// their MANAGED-SOURCE entries are read-only to user-facing writes except
// re-enabling a disabled one (enforced at commitConfigWrite). A user-owned
// profile sharing one of these names is NOT locked — invariance is gated on
// the on-disk entry's `source` being `managed`.
export const INVARIANT_PROFILE_NAMES = new Set<string>([
  ...DEFAULT_PROFILE_KEYS,
  ...BACKUP_PROFILE_KEYS,
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
  ...BACKUP_PROFILE_KEYS,
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
for (const key of DEFAULT_PROFILE_KEYS) {
  for (const provider of DEFAULT_PROFILE_PROVIDERS) {
    const impl = PROFILE_IMPLS[key][provider];
    if ((impl.model == null) === (impl.intent == null)) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] must set exactly one of \`intent\` or \`model\`.`,
      );
    }
    if (ROUTING_IDENTITY_PROVIDERS.has(impl.provider) && impl.model == null) {
      throw new Error(
        `PROFILE_IMPLS[${key}][${provider}] must pin a \`model\`: routing ` +
          `identities have no intent table, and the model selects the route.`,
      );
    }
    if (impl.model != null) {
      const routable =
        impl.provider === "vellum"
          ? getManagedUpstream(impl.model) !== null
          : impl.provider === "chatgpt"
            ? isCodexSubscriptionModel(impl.model)
            : isModelInCatalog(impl.provider, impl.model);
      if (!routable) {
        throw new Error(
          `PROFILE_IMPLS[${key}][${provider}] references model "${impl.model}" ` +
            `which is not ${impl.provider === "vellum" ? "served by any managed upstream" : impl.provider === "chatgpt" ? "in CODEX_SUBSCRIPTION_MODEL_IDS" : `in PROVIDER_CATALOG for provider "${impl.provider}"`}. ` +
            `Update model-catalog.ts or default-profile-catalog.ts.`,
        );
      }
    }
  }
}

// Backup profiles get the same eager verification as the vellum column: a
// pinned model that no managed upstream serves would make the fallback route
// undispatchable exactly when it is needed. The cross-provider rule (backup
// upstream differs from the primary's) is asserted in
// __tests__/default-profile-catalog-fallback.test.ts, arm pins included.
for (const key of BACKUP_PROFILE_KEYS) {
  const impl = BACKUP_PROFILE_IMPLS[key];
  if (impl.model == null || getManagedUpstream(impl.model) === null) {
    throw new Error(
      `BACKUP_PROFILE_IMPLS[${key}] references model "${impl.model ?? ""}" ` +
        `which is not served by any managed upstream. ` +
        `Update model-catalog.ts or default-profile-catalog.ts.`,
    );
  }
}

// The experiment arms substitute into the managed column at request time, so
// they need the same routability guarantee as the pins validated above: a
// LaunchDarkly arm must never select a model no managed upstream serves.
for (const [arm, model] of BALANCED_EXPERIMENT_MODELS) {
  if (getManagedUpstream(model) === null) {
    throw new Error(
      `BALANCED_EXPERIMENT_MODELS["${arm}"] references model "${model}" which ` +
        `is not served by any managed upstream. ` +
        `Update model-catalog.ts or default-profile-catalog.ts.`,
    );
  }
}

// Provider choices without a named column materialize from the shared BYOK
// templates; verify each one's resolved model lands in the catalog.
for (const provider of DEFAULT_PROVIDER_CHOICES) {
  if (isDefaultProfileProvider(provider)) {
    continue;
  }
  for (const key of DEFAULT_PROFILE_KEYS) {
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
  for (const key of DEFAULT_PROFILE_KEYS) {
    const impl = PROFILE_IMPLS[key].vellum;
    entries[key] = materializeProfile(impl, impl.provider);
  }
  for (const key of BACKUP_PROFILE_KEYS) {
    const impl = BACKUP_PROFILE_IMPLS[key];
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
 *
 * Materialized once at module load, so this is the shipped catalog: the
 * balanced-model experiment arm is applied by the provider-aware resolvers
 * (`resolveDefaultProfileForProvider`, `getEffectiveProfilesForProvider`),
 * which are what every runtime and client-facing reader of a default profile's
 * content goes through. The name-only readers that serve from this record
 * (`getEffectiveProfile`, `getEffectiveProfiles`) consume a profile's
 * existence and status, never its model.
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
    // A managed stub is the workspace's slot for a code-owned profile, never
    // a profile of its own, so with no body behind it there is nothing to
    // resolve. Only a backup name reaches this branch with a stub (the
    // default keys always have a body), and it reaches it on the columns
    // where the backups do not exist. Resolving to the stub would list a
    // profile with no provider or model and let a reference to it look
    // valid, which is precisely what `LLMSchema` rejects on those columns.
    if (isBackupProfileKey(name) && workspace?.source === "managed") {
      return undefined;
    }
    return workspace;
  }
  if (CODE_OWNED_PROFILE_NAMES.has(name)) {
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
 *   dispatch derives the upstream from the model per-request. The `chatgpt`
 *   column likewise stamps its routing identity with no connection;
 *   dispatch resolves the canonical subscription row per-request.
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

export { isDefaultProfileKey } from "./default-profile-names.js";

/**
 * The implementation of default profile `key` on `provider`: the named matrix
 * column when the provider has one, the shared BYOK template otherwise. The
 * managed column carries the balanced-model experiment arm, which is why the
 * lookup runs through here rather than reading `PROFILE_IMPLS` directly.
 */
function defaultProfileImplForProvider(
  key: DefaultProfileKey,
  provider: NonNullable<ProfileEntry["provider"]>,
): DefaultProfileTemplate {
  if (!isDefaultProfileProvider(provider)) {
    return { ...BYOK_PROFILE_IMPLS[key], provider };
  }
  if (provider === "vellum") {
    return managedProfileImpl(key);
  }
  return PROFILE_IMPLS[key][provider];
}

/**
 * The code-owned body a default profile name resolves to under the given
 * default provider. This is the single choke point where a default profile key
 * becomes a concrete body, so every consumer (the runtime resolver through
 * `resolveDefaultProfileForProvider`, the client-facing listing through
 * `getEffectiveProfilesForProvider`) reports the same model the request runs
 * on, experiment arm included.
 */
function defaultProfileBodyForProvider(
  name: string,
  defaultProvider: DefaultProviderConfig | null,
): ProfileEntry | undefined {
  if (!isDefaultProfileKey(name)) {
    // Backup profiles are companions of the managed (`vellum`) column only:
    // under a BYOK or chatgpt default provider the primaries carry no
    // `fallbackProfile` pointers, and the backups must not materialize
    // either, since the install may hold no credential for the backup's
    // provider. A null defaultProvider predates `llm.defaultProvider` and
    // resolves to the managed column, so it keeps its backups.
    if (
      isBackupProfileKey(name) &&
      !backupProfilesResolveUnderDefaultProvider(defaultProvider)
    ) {
      return undefined;
    }
    return CODE_DEFAULT_PROFILE_ENTRIES[name];
  }
  if (defaultProvider == null) {
    // The frozen `CODE_DEFAULT_PROFILE_ENTRIES` body, re-materialized so an
    // install that predates `llm.defaultProvider` still sees the arm.
    const managed = managedProfileImpl(name);
    return materializeProfile(managed, managed.provider);
  }
  const { provider } = defaultProvider;
  const impl = defaultProfileImplForProvider(name, provider);
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
 * Deliberately provider-agnostic: it lists the managed backups whatever
 * `llm.defaultProvider` says, because it resolves names against the passed
 * catalog alone and never reads config. Internal resolution and reference
 * validation use `getEffectiveProfilesForProvider`; user-facing selectors use
 * `getUserSelectableProfilesForProvider`, which additionally removes backups
 * from the managed column. Keeping those views separate lets automatic
 * fallback resolve an internal route without offering it as a direct choice.
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
    const entry = resolveDefaultProfileForProvider(
      workspaceProfiles,
      name,
      defaultProvider,
    );
    if (entry != null) {
      effective[name] = entry;
      continue;
    }
    // Nothing resolved, so the name must not survive from the workspace
    // spread above: a backup carrying only a managed stub on a column that
    // has no backups would otherwise be listed as an available profile with
    // no provider or model behind it.
    delete effective[name];
  }
  return effective;
}

/**
 * The effective profile view used by user-facing selectors. Managed backups
 * remain in the full effective catalog for automatic fallback resolution, but
 * are internal routes rather than profiles a user can choose directly.
 */
export function getUserSelectableProfilesForProvider(
  workspaceProfiles: Record<string, ProfileEntry> | undefined,
  defaultProvider: DefaultProviderConfig | null,
): Record<string, ProfileEntry> {
  const selectable = getEffectiveProfilesForProvider(
    workspaceProfiles,
    defaultProvider,
  );
  for (const name of BACKUP_PROFILE_KEYS) {
    delete selectable[name];
  }
  return selectable;
}
