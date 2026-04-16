import { z } from "zod";

/**
 * Unified LLM configuration schema.
 *
 * Defines the shape of the new top-level `llm` config block that consolidates
 * provider/model/effort/speed/thinking/contextWindow/pricingOverrides for all
 * call sites in the assistant.
 *
 * This file only defines the schema — it is not yet wired into the master
 * `AssistantConfigSchema` (PR 3) and is not yet consumed by any resolver
 * (PR 2). Downstream PRs handle migration, provider abstraction, and
 * call-site adoption.
 */

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

export const LLMProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
]);
export type LLMProvider = z.infer<typeof LLMProvider>;

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
  "analyzeConversation",
  "callAgent",
  "memoryExtraction",
  "memoryConsolidation",
  "memoryRetrieval",
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
  "watchCommentary",
  "watchSummary",
  "interactionClassifier",
  "styleAnalyzer",
  "inviteInstructionGenerator",
  "skillCategoryInference",
]);
export type LLMCallSite = z.infer<typeof LLMCallSiteEnum>;

// ---------------------------------------------------------------------------
// Effort & Speed
// ---------------------------------------------------------------------------

export const EffortEnum = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof EffortEnum>;

export const SpeedEnum = z.enum(["standard", "fast"]);
export type Speed = z.infer<typeof SpeedEnum>;

// ---------------------------------------------------------------------------
// Thinking & ContextWindow
//
// These mirror the shapes already declared in `schemas/inference.ts` but are
// redeclared here so the new `llm` namespace owns its own types and we can
// shrink them with `.partial()` for fragments without coupling back to
// the legacy top-level config. PRs 3 and beyond will deprecate the legacy
// declarations once the resolver is the single source of truth.
// ---------------------------------------------------------------------------

export const ThinkingSchema = z.object({
  enabled: z.boolean(),
  streamThinking: z.boolean(),
});
export type Thinking = z.infer<typeof ThinkingSchema>;

const ContextOverflowRecoverySchema = z.object({
  enabled: z.boolean(),
  safetyMarginRatio: z.number().finite().gt(0).lt(1),
  maxAttempts: z.number().int().positive(),
  interactiveLatestTurnCompression: z.enum(["truncate", "summarize", "drop"]),
  nonInteractiveLatestTurnCompression: z.enum([
    "truncate",
    "summarize",
    "drop",
  ]),
});

export const ContextWindowSchema = z.object({
  enabled: z.boolean(),
  maxInputTokens: z.number().int().positive(),
  targetBudgetRatio: z.number().finite().gt(0).lte(1),
  compactThreshold: z.number().finite().gt(0).lte(1),
  summaryBudgetRatio: z.number().finite().gt(0).lte(1),
  overflowRecovery: ContextOverflowRecoverySchema,
});
export type ContextWindow = z.infer<typeof ContextWindowSchema>;

/**
 * Manual deep-partial helper for `ContextWindowSchema`.
 *
 * Zod 4 dropped `ZodObject.deepPartial()`. This helper walks a single level
 * of nested ZodObject shapes and rebuilds them with every leaf marked
 * `.optional()`, which is the exact recursion depth `ContextWindowSchema`
 * needs (one level of nesting via `overflowRecovery`).
 */
function deepPartialObject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: z.ZodObject<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): z.ZodObject<any> {
  const newShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    if (value instanceof z.ZodObject) {
      newShape[key] = deepPartialObject(value).optional();
    } else {
      newShape[key] = (value as z.ZodTypeAny).optional();
    }
  }
  return z.object(newShape);
}

const ContextWindowDeepPartialSchema = deepPartialObject(ContextWindowSchema);

// ---------------------------------------------------------------------------
// Pricing overrides
// ---------------------------------------------------------------------------

export const PricingOverrideSchema = z.object({
  provider: z.string(),
  modelPattern: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});
export type PricingOverride = z.infer<typeof PricingOverrideSchema>;

// ---------------------------------------------------------------------------
// Base config (all fields required) and Fragment (all fields optional)
// ---------------------------------------------------------------------------

/**
 * Fully specified LLM config. Used for `llm.default` — every knob must be
 * set so the resolver always has a complete fallback.
 */
export const LLMConfigBase = z.object({
  provider: LLMProvider,
  model: z.string().min(1),
  maxTokens: z.number().int().positive(),
  effort: EffortEnum,
  speed: SpeedEnum,
  temperature: z.number().min(0).max(2).nullable(),
  thinking: ThinkingSchema,
  contextWindow: ContextWindowSchema,
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
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  effort: EffortEnum.optional(),
  speed: SpeedEnum.optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  thinking: ThinkingSchema.partial().optional(),
  contextWindow: ContextWindowDeepPartialSchema.optional(),
});
export type LLMConfigFragment = z.infer<typeof LLMConfigFragment>;

/**
 * Per-call-site config: a fragment plus an optional `profile` reference.
 * The resolver merges in the named profile (if any) before applying
 * call-site-level overrides.
 */
export const LLMCallSiteConfig = LLMConfigFragment.extend({
  profile: z.string().min(1).optional(),
});
export type LLMCallSiteConfig = z.infer<typeof LLMCallSiteConfig>;

// ---------------------------------------------------------------------------
// Top-level LLM schema
// ---------------------------------------------------------------------------

export const LLMSchema = z
  .object({
    default: LLMConfigBase,
    profiles: z.record(z.string().min(1), LLMConfigFragment).default({}),
    // `partialRecord` (vs `record`) makes call-site keys optional while still
    // rejecting keys that aren't members of `LLMCallSiteEnum` — exactly the
    // behavior we want (typo detection without requiring callers to declare
    // every call site).
    callSites: z.partialRecord(LLMCallSiteEnum, LLMCallSiteConfig).default({}),
    pricingOverrides: z.array(PricingOverrideSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const profileNames = new Set(Object.keys(config.profiles ?? {}));
    for (const [siteId, siteConfig] of Object.entries(config.callSites ?? {})) {
      if (siteConfig?.profile == null) continue;
      if (!profileNames.has(siteConfig.profile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["callSites", siteId, "profile"],
          message: `Profile "${siteConfig.profile}" referenced by call site "${siteId}" is not defined in llm.profiles`,
        });
      }
    }
  });

export type LLMConfig = z.infer<typeof LLMSchema>;
