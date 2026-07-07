import { z } from "zod";

import { DEFAULT_PROFILE_KEYS } from "../default-profile-names.js";

/**
 * Unified LLM configuration schema.
 *
 * Defines the shape of the top-level `llm` config block that consolidates
 * provider/model/effort/speed/thinking/contextWindow/pricingOverrides for all
 * call sites in the assistant. Wired into `AssistantConfigSchema` as the `llm`
 * field and consumed by `resolveCallSiteConfig` in `llm-resolver.ts`.
 */

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

export const LLMProvider = z
  .enum([
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "openrouter",
    "vercel-ai-gateway",
    "openai-compatible",
    "minimax",
    "atlascloud",
    "together",
  ])
  .meta({ id: "LLMProvider" });
type LLMProvider = z.infer<typeof LLMProvider>;

// ---------------------------------------------------------------------------
// Call-site enum
// ---------------------------------------------------------------------------

/**
 * The complete set of LLM call-site identifiers the assistant emits.
 *
 * Each ID corresponds to a logical place in the codebase that produces an LLM
 * request. Adding or removing a call site is a config-schema change — keep
 * this list in sync with the resolver and registry (introduced in PR 2).
 */
export const LLMCallSiteEnum = z.enum([
  "mainAgent",
  "subagentSpawn",
  "heartbeatAgent",
  "filingAgent",
  "compactionAgent",
  "analyzeConversation",
  "callAgent",
  "memoryExtraction",
  "memoryConsolidation",
  "memoryRetrieval",
  "memoryV2Migration",
  "memoryV2Sweep",
  "memoryRouter",
  "memoryV3SelectL2",
  "memoryV2Consolidation",
  "memoryRetrospective",
  "recall",
  "narrativeRefinement",
  "patternScan",
  "conversationSummarization",
  "conversationStarters",
  "replySuggestion",
  "conversationTitle",
  "commitMessage",
  "identityIntro",
  "emptyStateGreeting",
  "notificationDecision",
  "preferenceExtraction",
  "guardianQuestionCopy",
  "approvalCopy",
  "approvalConversation",
  "interactionClassifier",
  "styleAnalyzer",
  "inviteInstructionGenerator",
  "skillCategoryInference",
  "inference",
  "vision",
  "trustRuleSuggestion",
  "homeGreeting",
  "homeSuggestedPrompts",
  "workflowLeaf",
]);
export type LLMCallSite = z.infer<typeof LLMCallSiteEnum>;

// ---------------------------------------------------------------------------
// Effort, Speed & Verbosity
// ---------------------------------------------------------------------------

/**
 * Reasoning/thinking effort tier. `"none"` is a Vellum-specific value meaning
 * "the user has opted out of provider-side reasoning". Each provider
 * translates it however actually disables reasoning on that wire format:
 * OpenAI Responses sends `reasoning.effort: "none"` and Chat Completions
 * sends `reasoning_effort: "none"` explicitly, because omitting the field
 * causes OpenAI to default to `"medium"`; Anthropic omits
 * `output_config.effort` entirely, which is the documented opt-out there.
 * When adding a new provider, pick whichever encoding actually disables
 * reasoning on that wire format — do not assume omission is universally safe.
 * All other values map to provider-specific tiers via each provider's own
 * mapping table.
 */
const EffortEnum = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

export const SpeedEnum = z.enum(["standard", "fast"]);
export type Speed = z.infer<typeof SpeedEnum>;

/**
 * Response verbosity. Currently consumed by OpenAI's Responses API as
 * `text.verbosity` (low|medium|high). Providers that don't support this knob
 * are stripped in `retry.ts` normalization.
 */
const VerbosityEnum = z.enum(["low", "medium", "high"]);

// ---------------------------------------------------------------------------
// Leaf primitives (shared between LLMConfigBase and LLMConfigFragment)
//
// Each primitive is a Zod schema with no defaults attached. `LLMConfigBase`
// composes them with `.default(...)` so `LLMConfigBase.parse({})` returns a
// fully-defaulted object; `LLMConfigFragment` composes them with `.optional()`
// so absent fields stay absent. Centralizing the validation rules here keeps
// the two views consistent.
// ---------------------------------------------------------------------------

const ModelSchema = z.string().min(1);
const MaxTokensSchema = z.number().int().positive();
const TemperatureSchema = z.number().min(0).max(2).nullable();
// `top_p` (nucleus sampling). Range 0–1; `null` = "no opinion — let the
// provider pick its own default" (matches TemperatureSchema's null
// semantics). `RetryProvider` renames `topP`→`top_p` and only forwards a
// non-null value, so providers never receive `top_p: null`.
const TopPSchema = z.number().min(0).max(1).nullable();
// Named, code-resolved logit-bias preset a profile may opt into. The value is a
// preset *name*, not an inline token→bias map, so the workspace config stays
// small. This is profile-identity metadata, not inheritable config: the resolver
// strips it from the deep-merge and re-attaches it from the winning profile (see
// `profileConfigFragment` / `resolveCallSiteConfig`), and `RetryProvider`
// resolves it to a `logit_bias` map at request time, forwarded only on the
// Fireworks (OpenAI-compatible) path. Keep these literals in sync with the
// presets handled by `resolveLogitBiasPreset` in
// `providers/inference/logit-bias.ts` (kept separate to avoid a schema →
// provider import cycle).
const LogitBiasPresetSchema = z.enum(["suppress-cjk"]);

// ---------------------------------------------------------------------------
// Thinking & ContextWindow
//
// These mirror the shapes already declared in `schemas/inference.ts` but are
// redeclared here so the new `llm` namespace owns its own types. PRs 3 and
// beyond will deprecate the legacy declarations once the resolver is the
// single source of truth.
//
// Every leaf in the defaulted view carries a `.default(...)`, so
// `Schema.parse({})` returns a fully-defaulted object. This is critical for
// the loader's leaf-deletion recovery path: if any leaf in the user's config
// is invalid, the loader strips that leaf and re-parses; without
// schema-level defaults the parse would fail on missing required siblings,
// and the loader would fall back to `cloneDefaultConfig()`, discarding the
// user's other valid settings.
//
// Each defaulted schema has a sibling "fragment" schema with the same leaves
// wrapped in `.optional()` instead of `.default(...)`. The fragment view is
// used by `LLMConfigFragment` so partial overrides remain partial — Zod
// would inject defaults for absent fields if we used `Schema.partial()`, and
// the fragment contract is "any field may be absent and stays absent".
// ---------------------------------------------------------------------------

// Leaf primitives for thinking fields — defined once and reused by both the
// defaulted (`ThinkingSchema`) and fragment (`ThinkingFragmentSchema`) views.
const ThinkingEnabledSchema = z.boolean();
const ThinkingStreamThinkingSchema = z.boolean();
// Gemini-style thinking depth knob. Maps to Gemini's `thinkingLevel`. Other
// providers (Anthropic, OpenRouter) ignore this field — they use `effort`
// instead to size reasoning. Optional with no default so the underlying
// provider can pick its own default (Gemini 3.x defaults to "medium").
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

const ThinkingSchema = z.object({
  enabled: ThinkingEnabledSchema.default(true),
  streamThinking: ThinkingStreamThinkingSchema.default(true),
  level: ThinkingLevelSchema.optional(),
});

// Fragment view: every field optional, no defaults injected. Defining this
// separately (rather than `ThinkingSchema.partial()`) avoids having Zod
// inject defaults for absent fields when a partial override is parsed —
// the fragment contract is "any field may be absent and stays absent".
const ThinkingFragmentSchema = z.object({
  enabled: ThinkingEnabledSchema.optional(),
  streamThinking: ThinkingStreamThinkingSchema.optional(),
  level: ThinkingLevelSchema.optional(),
});

// Leaf primitives for context-overflow recovery.
const OverflowEnabledSchema = z.boolean();
const OverflowSafetyMarginRatioSchema = z.number().finite().gt(0).lt(1);
const OverflowMaxAttemptsSchema = z.number().int().positive();
const OverflowLatestTurnCompressionSchema = z.enum([
  "truncate",
  "summarize",
  "drop",
]);

const ContextOverflowRecoverySchema = z.object({
  enabled: OverflowEnabledSchema.default(true),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.default(0.05),
  maxAttempts: OverflowMaxAttemptsSchema.default(3),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("summarize"),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.default("truncate"),
});

const ContextOverflowRecoveryFragmentSchema = z.object({
  enabled: OverflowEnabledSchema.optional(),
  safetyMarginRatio: OverflowSafetyMarginRatioSchema.optional(),
  maxAttempts: OverflowMaxAttemptsSchema.optional(),
  interactiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
  nonInteractiveLatestTurnCompression:
    OverflowLatestTurnCompressionSchema.optional(),
});

// Leaf primitives for context-window fields.
const ContextEnabledSchema = z.boolean();
export const DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS = 200000;

const ContextMaxInputTokensSchema = z.number().int().positive();
const ContextTargetBudgetRatioSchema = z.number().finite().gt(0).lte(1);
const ContextCompactThresholdSchema = z.number().finite().gt(0).lte(1);
const ContextSummaryBudgetRatioSchema = z.number().finite().gt(0).lte(1);

const ContextWindowSchema = z.object({
  enabled: ContextEnabledSchema.default(true),
  maxInputTokens: ContextMaxInputTokensSchema.default(
    DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
  ),
  targetBudgetRatio: ContextTargetBudgetRatioSchema.default(0.3),
  compactThreshold: ContextCompactThresholdSchema.default(0.8),
  summaryBudgetRatio: ContextSummaryBudgetRatioSchema.default(0.05),
  overflowRecovery: ContextOverflowRecoverySchema.default(
    ContextOverflowRecoverySchema.parse({}),
  ),
});
export type ContextWindow = z.infer<typeof ContextWindowSchema>;

// Fragment view of `ContextWindowSchema` — all fields optional and no defaults
// injected. Nested `overflowRecovery` likewise uses its fragment view, so a
// partial override like `{ overflowRecovery: { maxAttempts: 5 } }` produces
// exactly that and nothing else.
const ContextWindowDeepPartialSchema = z.object({
  enabled: ContextEnabledSchema.optional(),
  maxInputTokens: ContextMaxInputTokensSchema.optional(),
  targetBudgetRatio: ContextTargetBudgetRatioSchema.optional(),
  compactThreshold: ContextCompactThresholdSchema.optional(),
  summaryBudgetRatio: ContextSummaryBudgetRatioSchema.optional(),
  overflowRecovery: ContextOverflowRecoveryFragmentSchema.optional(),
});

// ---------------------------------------------------------------------------
// OpenRouter provider-routing preferences
//
// OpenRouter's `/v1/chat/completions` and `/v1/messages` endpoints both accept
// a `provider: { only: [...] }` body field that restricts which upstream
// providers (Anthropic, Google, etc.) may fulfill a request. Exposed here so
// users can pin routing via config without touching the wire-format knobs
// directly. Nested shape keeps room for sibling OpenRouter knobs (`order`,
// `allow_fallbacks`, …) to be added later without another schema reshape.
// ---------------------------------------------------------------------------

const OpenRouterOnlyItemSchema = z.string().min(1);

const OpenRouterSchema = z.object({
  only: z.array(OpenRouterOnlyItemSchema).default([]),
});

const OpenRouterDeepPartialSchema = z.object({
  only: z.array(OpenRouterOnlyItemSchema).optional(),
});

// ---------------------------------------------------------------------------
// Profile metadata
// ---------------------------------------------------------------------------

/**
 * Distinguishes daemon-managed profiles (overwritten on every startup) from
 * user-created ones (never touched by the daemon).
 */
const ProfileSource = z.enum(["managed", "user"]);
type ProfileSource = z.infer<typeof ProfileSource>;

// ---------------------------------------------------------------------------
// Pricing overrides
// ---------------------------------------------------------------------------

const PricingOverrideSchema = z.object({
  provider: z.string(),
  modelPattern: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// Base config (all fields defaulted) and Fragment (all fields optional)
// ---------------------------------------------------------------------------

/**
 * Fully specified LLM config. Used for `llm.default` — every knob has a
 * schema-level default, so `LLMConfigBase.parse({})` returns a complete
 * fallback object. This is essential for the loader's leaf-deletion recovery
 * path; see the comment on `ThinkingSchema` above.
 */
export const LLMConfigBase = z.object({
  provider: LLMProvider.default("anthropic"),
  /**
   * Name of a `provider_connections` row to use for this resolved config.
   * Optional and additive: when set, the dispatcher resolves auth from the
   * connection (mix-and-match managed/your-own per profile). When unset,
   * the dispatcher falls back to the legacy `provider` lookup.
   *
   * Lives on the merged base type so it flows through `resolveCallSiteConfig`
   * naturally — the underlying profile-level field is on `ProfileEntry`.
   */
  provider_connection: z.string().min(1).optional(),
  model: ModelSchema.default("claude-opus-4-8"),
  maxTokens: MaxTokensSchema.default(64000),
  effort: EffortEnum.default("max"),
  speed: SpeedEnum.default("standard"),
  verbosity: VerbosityEnum.default("medium"),
  temperature: TemperatureSchema.default(null),
  topP: TopPSchema.default(null),
  thinking: ThinkingSchema.default(ThinkingSchema.parse({})),
  contextWindow: ContextWindowSchema.default(ContextWindowSchema.parse({})),
  openrouter: OpenRouterSchema.default(OpenRouterSchema.parse({})),
  // Not deep-merged like the other fields: `resolveCallSiteConfig` sets this
  // from the single highest-precedence profile that won resolution (see
  // `profileConfigFragment`, which strips it from the merge), so a preset
  // can't bleed from a lower-precedence profile into one that didn't opt in.
  logitBias: LogitBiasPresetSchema.optional(),
  /**
   * Opt this config out of prompt caching. Providers send no cache
   * breakpoints and strip caller-stamped `cache_control` markers. Intended
   * for one-shot call sites whose prompts never repeat (or repeat slower
   * than the cache TTL), where every breakpoint is a paid cache write with
   * no future read. Optional (no schema default) so it only appears in
   * resolved configs when a layer sets it.
   */
  disableCache: z.boolean().optional(),
});
export type LLMConfigBase = z.infer<typeof LLMConfigBase>;

/**
 * Partial LLM config used for profiles and call-site overrides. Each top-level
 * field is optional; nested `thinking` and `contextWindow` accept partial
 * objects so callers can override individual leaves (e.g. `{ thinking:
 * { enabled: false } }`).
 */
export const LLMConfigFragment = z
  .object({
    provider: LLMProvider.optional(),
    model: ModelSchema.optional(),
    maxTokens: MaxTokensSchema.optional(),
    effort: EffortEnum.optional(),
    speed: SpeedEnum.optional(),
    verbosity: VerbosityEnum.optional(),
    temperature: TemperatureSchema.optional(),
    topP: TopPSchema.optional(),
    thinking: ThinkingFragmentSchema.optional(),
    contextWindow: ContextWindowDeepPartialSchema.optional(),
    openrouter: OpenRouterDeepPartialSchema.optional(),
    logitBias: LogitBiasPresetSchema.optional(),
    disableCache: z.boolean().optional(),
  })
  .meta({ id: "LLMConfigFragment" });
export type LLMConfigFragment = z.infer<typeof LLMConfigFragment>;

export const ProfileStatusSchema = z
  .enum(["active", "disabled"])
  .meta({ id: "ProfileStatus" });
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

// ---------------------------------------------------------------------------
// Mix profiles
//
// A "mix" profile carries no model config of its own. Instead it references a
// weighted list of other (standard) profiles; at resolve time exactly one
// constituent is chosen by weight. The pick is a deterministic function of a
// per-conversation seed (the conversation id — see `resolveCallSiteConfig`'s
// `selectionSeed`), so a conversation always lands on the same arm across all
// its turns, retries, and even daemon restarts, while different conversations
// split according to the weights — and the chosen arm is recordable for A/B
// evaluation. Weights are relative (normalized by their sum at pick time), so
// `[{weight:80},{weight:20}]` and `[{weight:4},{weight:1}]` are equivalent.
// ---------------------------------------------------------------------------
const MixArmSchema = z.object({
  profile: z.string().min(1),
  weight: z.number().finite().positive(),
});
export type MixArm = z.infer<typeof MixArmSchema>;

const MixSchema = z.array(MixArmSchema).min(2);

/**
 * A named profile entry: an `LLMConfigFragment` augmented with
 * presentation/ownership metadata. These fields are intentionally kept off
 * `LLMConfigFragment` so they don't leak into `LLMCallSiteConfig` or the
 * resolver's deep-merge output.
 */
export const ProfileEntry = LLMConfigFragment.extend({
  source: ProfileSource.optional(),
  /**
   * `.nullable()` is intentional: the PUT `/v1/config/llm/profiles/:name`
   * route uses `null` as the "clear this field" sentinel (edit mode sends
   * `label: null` for a cleared display name — see
   * `handleReplaceInferenceProfile` in
   * `runtime/routes/conversation-query-routes.ts`). Without `.nullable()`,
   * Zod rejects `{ label: null }` at parse time before the route handler
   * ever sees it, and the clear path is unreachable from any client.
   * `.min(1)` still applies to string values so empty strings remain
   * rejected — `null` is the only non-string-non-undefined input accepted.
   */
  label: z.string().min(1).nullable().optional(),
  description: z.string().optional(),
  /**
   * Name of a `provider_connections` row to use for this profile.
   * The dispatcher resolves auth from this connection; the legacy `provider`
   * and `source` fields remain as read-only deprecated fallbacks for profiles
   * not yet backfilled by the boot-time migration.
   */
  provider_connection: z.string().min(1).optional(),
  /**
   * Absent means active. `.nullable()` matches `label` so the PUT route's
   * "send `null` to clear" sentinel works for status too — a managed
   * re-enable body of `{status: null}` clears back to active-by-absence
   * (see `applyManagedProfileReenable`).
   */
  status: ProfileStatusSchema.nullable().optional(),
  /**
   * When present, this profile is a "mix": it carries no model config and
   * instead references a weighted list of standard profiles. The resolver
   * expands a mix by a seeded weighted pick (see `resolveCallSiteConfig`).
   * `LLMSchema.superRefine` enforces that (a) every referenced profile exists,
   * (b) no referenced profile is itself a mix (no nesting), (c) no arm
   * references the mix itself, and (d) a mix carries no `LLMConfigFragment`
   * config field — only metadata (`label`, `description`, `status`, `source`)
   * may accompany `mix`.
   */
  mix: MixSchema.optional(),
});
export type ProfileEntry = z.infer<typeof ProfileEntry>;

/**
 * Per-call-site config: a fragment plus an optional `profile` reference.
 * The resolver merges in the named profile (if any) before applying
 * call-site-level overrides.
 */
const LLMCallSiteConfig = LLMConfigFragment.extend({
  profile: z.string().min(1).optional(),
});
type LLMCallSiteConfig = z.infer<typeof LLMCallSiteConfig>;

// ---------------------------------------------------------------------------
// Top-level LLM schema
// ---------------------------------------------------------------------------

export const LLMSchema = z
  .object({
    default: LLMConfigBase.default(LLMConfigBase.parse({})),
    profiles: z.record(z.string().min(1), ProfileEntry).default({}),
    // Presentation-only order for named profiles. The resolver ignores this;
    // clients use it to render profile pickers consistently.
    profileOrder: z.array(z.string().min(1)).default([]),
    // `partialRecord` (vs `record`) makes call-site keys optional while still
    // rejecting keys that aren't members of `LLMCallSiteEnum` — exactly the
    // behavior we want (typo detection without requiring callers to declare
    // every call site). Latency-optimized defaults for background call sites
    // are seeded into the user's on-disk config by migration 040, not at
    // schema level, so `LLMSchema.parse({})` yields an empty map.
    callSites: z.partialRecord(LLMCallSiteEnum, LLMCallSiteConfig).default({}),
    activeProfile: z.string().min(1).optional(),
    // The profile the advisor role consults when spawned as a subagent (chosen
    // under Models & Services). It is excluded from the chat-profile pickers so
    // it can't be selected as the assistant's chat model.
    advisorProfile: z.string().min(1).optional(),
    // TTL bounds for inference profile sessions. `defaultTtlSeconds` is read by
    // the CLI to apply when `--ttl` is omitted; the daemon handler itself only
    // reads `maxTtlSeconds` (to clamp caller-supplied values).
    profileSession: z
      .object({
        defaultTtlSeconds: z.number().int().min(1).default(1800),
        maxTtlSeconds: z.number().int().min(1).default(43200),
      })
      .default({ defaultTtlSeconds: 1800, maxTtlSeconds: 43200 }),
    pricingOverrides: z.array(PricingOverrideSchema).default([]),
  })
  .superRefine((config, ctx) => {
    // The always-available default profiles are code-defined
    // (`default-profile-catalog.ts`) and resolve whether or not they are
    // materialized in `llm.profiles`, so their names are always valid
    // reference targets. The flag-gated `os-beta` is excluded: it resolves
    // only while a workspace entry exists, so a reference to it is valid
    // only when that entry is present in `config.profiles`.
    const profileNames = new Set([
      ...Object.keys(config.profiles ?? {}),
      ...DEFAULT_PROFILE_KEYS,
    ]);
    for (const [siteId, siteConfig] of Object.entries(config.callSites ?? {})) {
      if (siteConfig?.profile == null) continue;
      if (!profileNames.has(siteConfig.profile)) {
        ctx.addIssue({
          code: "custom",
          path: ["callSites", siteId, "profile"],
          message: `Profile "${siteConfig.profile}" referenced by call site "${siteId}" is not defined in llm.profiles`,
        });
      }
    }
    if (
      config.activeProfile != null &&
      !profileNames.has(config.activeProfile)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["activeProfile"],
        message: `Profile "${config.activeProfile}" referenced by llm.activeProfile is not defined in llm.profiles`,
      });
    }
    if (
      config.advisorProfile != null &&
      !profileNames.has(config.advisorProfile)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["advisorProfile"],
        message: `Profile "${config.advisorProfile}" referenced by llm.advisorProfile is not defined in llm.profiles`,
      });
    }

    // --- Mix profile validation --------------------------------------------
    // Config keys a mix profile must NOT also set (a mix only references other
    // profiles + metadata). Derived from the fragment shape plus the
    // ProfileEntry-only `provider_connection` so it can't drift if a new config
    // field is added to `LLMConfigFragment`.
    const MIX_DISALLOWED_CONFIG_KEYS = [
      ...Object.keys(LLMConfigFragment.shape),
      "provider_connection",
    ];
    const mixProfileNames = new Set(
      Object.entries(config.profiles ?? {})
        .filter(([, profile]) => profile?.mix != null)
        .map(([name]) => name),
    );
    for (const [name, profile] of Object.entries(config.profiles ?? {})) {
      if (profile?.mix == null) continue;
      // (d) A mix must not also carry model config — the resolved config comes
      // entirely from the chosen constituent.
      for (const key of MIX_DISALLOWED_CONFIG_KEYS) {
        if ((profile as Record<string, unknown>)[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, key],
            message: `Mix profile "${name}" cannot also set "${key}" — a mix only references other profiles plus metadata (label, description, status).`,
          });
        }
      }
      for (const [index, arm] of profile.mix.entries()) {
        // (c) No self-reference.
        if (arm.profile === name) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" cannot reference itself.`,
          });
          continue;
        }
        // (a) Referenced profile must exist.
        if (!profileNames.has(arm.profile)) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" references profile "${arm.profile}" which is not defined in llm.profiles.`,
          });
          continue;
        }
        // (b) No nesting — a mix arm must be a standard (non-mix) profile.
        if (mixProfileNames.has(arm.profile)) {
          ctx.addIssue({
            code: "custom",
            path: ["profiles", name, "mix", index, "profile"],
            message: `Mix profile "${name}" references another mix profile "${arm.profile}" — mixes cannot be nested; constituents must be standard profiles.`,
          });
        }
      }
    }
  });

export type LLMConfig = z.infer<typeof LLMSchema>;
