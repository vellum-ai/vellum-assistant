import { z } from "zod";

const VALID_LATEST_TURN_COMPRESSION_POLICIES = [
  "truncate",
  "summarize",
  "drop",
] as const;

export { VALID_LATEST_TURN_COMPRESSION_POLICIES };

export const ThinkingConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "thinking.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether to enable extended thinking (chain-of-thought) for the model",
      ),
    streamThinking: z
      .boolean({ error: "thinking.streamThinking must be a boolean" })
      .default(false)
      .describe(
        "Whether to stream the model's thinking tokens to the client in real time",
      ),
  })
  .describe("Extended thinking (chain-of-thought) configuration");

export const EffortSchema = z
  .enum(["low", "medium", "high", "max"], {
    error: 'effort must be "low", "medium", "high", or "max"',
  })
  .default("high")
  .describe(
    "How much effort the model should put into its response — lower effort is faster and cheaper",
  );

export type Effort = z.infer<typeof EffortSchema>;

export const ContextOverflowRecoveryConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "contextWindow.overflowRecovery.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Whether to automatically recover when the context window overflows",
      ),
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
      .default(0.05)
      .describe(
        "Fraction of the context window reserved as a safety margin to prevent overflow",
      ),
    maxAttempts: z
      .number({
        error: "contextWindow.overflowRecovery.maxAttempts must be a number",
      })
      .int("contextWindow.overflowRecovery.maxAttempts must be an integer")
      .positive(
        "contextWindow.overflowRecovery.maxAttempts must be a positive integer",
      )
      .default(3)
      .describe("Maximum number of recovery attempts before giving up"),
    interactiveLatestTurnCompression: z
      .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
        error: `contextWindow.overflowRecovery.interactiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
          ", ",
        )}`,
      })
      .default("summarize")
      .describe(
        "How to handle the latest turn during overflow recovery in interactive mode",
      ),
    nonInteractiveLatestTurnCompression: z
      .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
        error: `contextWindow.overflowRecovery.nonInteractiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
          ", ",
        )}`,
      })
      .default("truncate")
      .describe(
        "How to handle the latest turn during overflow recovery in non-interactive (background) mode",
      ),
  })
  .describe(
    "Controls how the assistant recovers when the context window overflows",
  );

export const ContextWindowConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "contextWindow.enabled must be a boolean" })
      .default(true)
      .describe("Whether context window management is enabled"),
    maxInputTokens: z
      .number({ error: "contextWindow.maxInputTokens must be a number" })
      .int("contextWindow.maxInputTokens must be an integer")
      .positive("contextWindow.maxInputTokens must be a positive integer")
      .default(200000)
      .describe("Maximum number of input tokens allowed in the context window"),
    targetBudgetRatio: z
      .number({ error: "contextWindow.targetBudgetRatio must be a number" })
      .finite("contextWindow.targetBudgetRatio must be finite")
      .gt(0, "contextWindow.targetBudgetRatio must be greater than 0")
      .lte(1, "contextWindow.targetBudgetRatio must be less than or equal to 1")
      .default(0.3)
      .describe(
        "Target ratio of the context window to retain after compaction — must be less than compactThreshold",
      ),
    compactThreshold: z
      .number({ error: "contextWindow.compactThreshold must be a number" })
      .finite("contextWindow.compactThreshold must be finite")
      .gt(0, "contextWindow.compactThreshold must be greater than 0")
      .lte(1, "contextWindow.compactThreshold must be less than or equal to 1")
      .default(0.8)
      .describe("Context window usage ratio at which compaction is triggered"),
    summaryBudgetRatio: z
      .number({ error: "contextWindow.summaryBudgetRatio must be a number" })
      .finite("contextWindow.summaryBudgetRatio must be finite")
      .gt(0, "contextWindow.summaryBudgetRatio must be greater than 0")
      .lte(
        1,
        "contextWindow.summaryBudgetRatio must be less than or equal to 1",
      )
      .default(0.05)
      .describe(
        "Fraction of the context window allocated for conversation summaries",
      ),
    overflowRecovery: ContextOverflowRecoveryConfigSchema.default(
      ContextOverflowRecoveryConfigSchema.parse({}),
    ),
  })
  .describe(
    "Context window management — controls compaction, overflow recovery, and token budgets",
  );

export const ModelPricingOverrideSchema = z
  .object({
    provider: z
      .string({ error: "pricingOverrides[].provider must be a string" })
      .describe("Provider name to match (e.g. 'anthropic', 'openai')"),
    modelPattern: z
      .string({
        error: "pricingOverrides[].modelPattern must be a string",
      })
      .describe("Glob pattern to match model names against"),
    inputPer1M: z
      .number({ error: "pricingOverrides[].inputPer1M must be a number" })
      .nonnegative(
        "pricingOverrides[].inputPer1M must be a non-negative number",
      )
      .describe("Cost per 1 million input tokens in USD"),
    outputPer1M: z
      .number({ error: "pricingOverrides[].outputPer1M must be a number" })
      .nonnegative(
        "pricingOverrides[].outputPer1M must be a non-negative number",
      )
      .describe("Cost per 1 million output tokens in USD"),
  })
  .describe(
    "Custom pricing override for a specific provider/model combination",
  );

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextOverflowRecoveryConfig = z.infer<
  typeof ContextOverflowRecoveryConfigSchema
>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
