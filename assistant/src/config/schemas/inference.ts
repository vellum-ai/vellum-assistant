import { z } from "zod";

const VALID_LATEST_TURN_COMPRESSION_POLICIES = [
  "truncate",
  "summarize",
  "drop",
] as const;

export { VALID_LATEST_TURN_COMPRESSION_POLICIES };

export const ThinkingConfigSchema = z.object({
  enabled: z
    .boolean({ error: "thinking.enabled must be a boolean" })
    .default(false),
  streamThinking: z
    .boolean({ error: "thinking.streamThinking must be a boolean" })
    .default(false),
});

export const EffortSchema = z
  .enum(["low", "medium", "high"], {
    error: 'effort must be "low", "medium", or "high"',
  })
  .default("high");

export type Effort = z.infer<typeof EffortSchema>;

export const ContextOverflowRecoveryConfigSchema = z.object({
  enabled: z
    .boolean({
      error: "contextWindow.overflowRecovery.enabled must be a boolean",
    })
    .default(true),
  safetyMarginRatio: z
    .number({
      error:
        "contextWindow.overflowRecovery.safetyMarginRatio must be a number",
    })
    .finite("contextWindow.overflowRecovery.safetyMarginRatio must be finite")
    .gt(
      0,
      "contextWindow.overflowRecovery.safetyMarginRatio must be greater than 0",
    )
    .lt(
      1,
      "contextWindow.overflowRecovery.safetyMarginRatio must be less than 1",
    )
    .default(0.05),
  maxAttempts: z
    .number({
      error: "contextWindow.overflowRecovery.maxAttempts must be a number",
    })
    .int("contextWindow.overflowRecovery.maxAttempts must be an integer")
    .positive(
      "contextWindow.overflowRecovery.maxAttempts must be a positive integer",
    )
    .default(3),
  interactiveLatestTurnCompression: z
    .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
      error: `contextWindow.overflowRecovery.interactiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
        ", ",
      )}`,
    })
    .default("summarize"),
  nonInteractiveLatestTurnCompression: z
    .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
      error: `contextWindow.overflowRecovery.nonInteractiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
        ", ",
      )}`,
    })
    .default("truncate"),
});

export const ContextWindowConfigSchema = z.object({
  enabled: z
    .boolean({ error: "contextWindow.enabled must be a boolean" })
    .default(true),
  maxInputTokens: z
    .number({ error: "contextWindow.maxInputTokens must be a number" })
    .int("contextWindow.maxInputTokens must be an integer")
    .positive("contextWindow.maxInputTokens must be a positive integer")
    .default(200000),
  targetInputTokens: z
    .number({ error: "contextWindow.targetInputTokens must be a number" })
    .int("contextWindow.targetInputTokens must be an integer")
    .positive("contextWindow.targetInputTokens must be a positive integer")
    .default(110000),
  compactThreshold: z
    .number({ error: "contextWindow.compactThreshold must be a number" })
    .finite("contextWindow.compactThreshold must be finite")
    .gt(0, "contextWindow.compactThreshold must be greater than 0")
    .lte(1, "contextWindow.compactThreshold must be less than or equal to 1")
    .default(0.8),
  preserveRecentUserTurns: z
    .number({ error: "contextWindow.preserveRecentUserTurns must be a number" })
    .int("contextWindow.preserveRecentUserTurns must be an integer")
    .positive(
      "contextWindow.preserveRecentUserTurns must be a positive integer",
    )
    .default(8),
  summaryBudgetRatio: z
    .number({ error: "contextWindow.summaryBudgetRatio must be a number" })
    .finite("contextWindow.summaryBudgetRatio must be finite")
    .gt(0, "contextWindow.summaryBudgetRatio must be greater than 0")
    .lte(1, "contextWindow.summaryBudgetRatio must be less than or equal to 1")
    .default(0.05),
  overflowRecovery: ContextOverflowRecoveryConfigSchema.default(
    ContextOverflowRecoveryConfigSchema.parse({}),
  ),
});

export const ModelPricingOverrideSchema = z.object({
  provider: z.string({ error: "pricingOverrides[].provider must be a string" }),
  modelPattern: z.string({
    error: "pricingOverrides[].modelPattern must be a string",
  }),
  inputPer1M: z
    .number({ error: "pricingOverrides[].inputPer1M must be a number" })
    .nonnegative("pricingOverrides[].inputPer1M must be a non-negative number"),
  outputPer1M: z
    .number({ error: "pricingOverrides[].outputPer1M must be a number" })
    .nonnegative(
      "pricingOverrides[].outputPer1M must be a non-negative number",
    ),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextOverflowRecoveryConfig = z.infer<
  typeof ContextOverflowRecoveryConfigSchema
>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
