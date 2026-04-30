import { z } from "zod";

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

const LLMProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
]);
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
  "recall",
  "narrativeRefinement",
  "patternScan",
  "conversationSummarization",
  "conversationStarters",
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
  "meetConsentMonitor",
  "meetChatOpportunity",
  "inference",
  "feedEventCopy",
  "trustRuleSuggestion",
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
export type Effort = z.infer<typeof EffortEnum>;

export const SpeedEnum = z.enum(["standard", "fast"]);
export type Speed = z.infer<typeof SpeedEnum>;

/**
 * Response verbosity. Currently consumed by OpenAI's Responses API as
 * `text.verbosity` (low|medium|high). Providers that don't support this knob
 * are stripped in `retry.ts` normalization.
 */
const VerbosityEnum = z.enum(["low", "medium", "high"]);
export type Verbosity = z.infer<typeof VerbosityEnum>;

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

const ThinkingSchema = z.object({
  enabled: ThinkingEnabledSchema.default(true),
  streamThinking: ThinkingStreamThinkingSchema.default(true),
});
export type Thinking = z.infer<typeof ThinkingSchema>;

// Fragment view: every field optional, no defaults injected. Defining this
// separately (rather than `ThinkingSchema.partial()`) avoids having Zod
// inject defaults for absent fields when a partial override is parsed —
// the fragment contract is "any field may be absent and stays absent".
const ThinkingFragmentSchema = z.object({
  enabled: ThinkingEnabledSchema.optional(),
  streamThinking: ThinkingStreamThinkingSchema.optional(),
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
const ContextMaxInputTokensSchema = z.number().int().positive();
const ContextTargetBudgetRatioSchema = z.number().finite().gt(0).lte(1);
const ContextCompactThresholdSchema = z.number().finite().gt(0).lte(1);
const ContextSummaryBudgetRatioSchema = z.number().finite().gt(0).lte(1);

const ContextWindowSchema = z.object({
  enabled: ContextEnabledSchema.default(true),
  maxInputTokens: ContextMaxInputTokensSchema.default(200000),
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
export type OpenRouter = z.infer<typeof OpenRouterSchema>;

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
export const ProfileSource = z.enum(["managed", "user"]);
export type ProfileSource = z.infer<typeof ProfileSource>;

// ---------------------------------------------------------------------------
// Pricing overrides
// ---------------------------------------------------------------------------

const PricingOverrideSchema = z.object({
  provider: z.string(),
  modelPattern: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;

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
  model: ModelSchema.default("claude-opus-4-7"),
  maxTokens: MaxTokensSchema.default(64000),
  effort: EffortEnum.default("max"),
  speed: SpeedEnum.default("standard"),
  verbosity: VerbosityEnum.default("medium"),
  temperature: TemperatureSchema.default(null),
  thinking: ThinkingSchema.default(ThinkingSchema.parse({})),
  contextWindow: ContextWindowSchema.default(ContextWindowSchema.parse({})),
  openrouter: OpenRouterSchema.default(OpenRouterSchema.parse({})),
});
export type LLMConfigBase = z.infer<typeof LLMConfigBase>;

/**
 * Partial LLM config used for profiles and call-site overrides. Each top-level
 * field is optional; nested `thinking` and `contextWindow` accept partial
 * objects so callers can override individual leaves (e.g. `{ thinking:
 * { enabled: false } }`).
 */
export const LLMConfigFragment = z.object({
  provider: LLMProvider.optional(),
  model: ModelSchema.optional(),
  maxTokens: MaxTokensSchema.optional(),
  effort: EffortEnum.optional(),
  speed: SpeedEnum.optional(),
  verbosity: VerbosityEnum.optional(),
  temperature: TemperatureSchema.optional(),
  thinking: ThinkingFragmentSchema.optional(),
  contextWindow: ContextWindowDeepPartialSchema.optional(),
  openrouter: OpenRouterDeepPartialSchema.optional(),
});
export type LLMConfigFragment = z.infer<typeof LLMConfigFragment>;

/**
 * A named profile entry: an `LLMConfigFragment` augmented with
 * presentation/ownership metadata. These fields are intentionally kept off
 * `LLMConfigFragment` so they don't leak into `LLMCallSiteConfig` or the
 * resolver's deep-merge output.
 */
export const ProfileEntry = LLMConfigFragment.extend({
  source: ProfileSource.optional(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
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
export type LLMCallSiteConfig = z.infer<typeof LLMCallSiteConfig>;

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
    pricingOverrides: z.array(PricingOverrideSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const profileNames = new Set(Object.keys(config.profiles ?? {}));
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
  });

export type LLMConfig = z.infer<typeof LLMSchema>;
