import { z } from "zod";

const DEFAULT_WORKER_CONCURRENCY = 2;
const DEFAULT_SLOW_LLM_CONCURRENCY = 1;
const DEFAULT_FAST_CONCURRENCY = 2;
const DEFAULT_EMBED_CONCURRENCY = 2;

const positiveInt = (field: string) =>
  z
    .number({ error: `memory.jobs.${field} must be a number` })
    .int(`memory.jobs.${field} must be an integer`)
    .positive(`memory.jobs.${field} must be a positive integer`);

// Input shape allows all fields to be omitted so we can distinguish
// "user explicitly set workerConcurrency" from "user accepted the default"
// when deriving lane caps. The output shape (after transform) always has
// all four fields populated.
const MemoryJobsConfigInputSchema = z.object({
  workerConcurrency: positiveInt("workerConcurrency")
    .optional()
    .describe("Number of concurrent workers processing memory jobs"),
  batchSize: positiveInt("batchSize")
    .default(10)
    .describe("Number of memory items processed per batch"),
  stalledJobTimeoutMs: positiveInt("stalledJobTimeoutMs")
    .default(30 * 60 * 1000)
    .describe(
      "Timeout in milliseconds after which a stalled memory job is considered failed",
    ),
  slowLlmConcurrency: positiveInt("slowLlmConcurrency")
    .optional()
    .describe(
      "Concurrent slow LLM-bound jobs (graph consolidation, narrative refine, etc.)",
    ),
  fastConcurrency: positiveInt("fastConcurrency")
    .optional()
    .describe(
      "Concurrent fast jobs (concept-page embed, prunes, media processing, etc.)",
    ),
  embedConcurrency: positiveInt("embedConcurrency")
    .optional()
    .describe(
      "Concurrent segment-embed jobs (gated by Qdrant circuit breaker)",
    ),
});

export const MemoryJobsConfigSchema = MemoryJobsConfigInputSchema.transform(
  (input) => {
    // When `workerConcurrency` is explicitly set but lane caps are not,
    // derive lane caps so existing user configs gain the per-lane fix
    // without edits. Explicit lane caps always win.
    const workerConcurrencyExplicit = input.workerConcurrency !== undefined;
    const workerConcurrency =
      input.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY;

    const slowLlmConcurrency =
      input.slowLlmConcurrency ??
      (workerConcurrencyExplicit
        ? Math.max(1, Math.floor(workerConcurrency / 2))
        : DEFAULT_SLOW_LLM_CONCURRENCY);

    const fastConcurrency =
      input.fastConcurrency ??
      (workerConcurrencyExplicit
        ? workerConcurrency
        : DEFAULT_FAST_CONCURRENCY);

    const embedConcurrency =
      input.embedConcurrency ??
      (workerConcurrencyExplicit
        ? workerConcurrency
        : DEFAULT_EMBED_CONCURRENCY);

    return {
      workerConcurrency,
      batchSize: input.batchSize,
      stalledJobTimeoutMs: input.stalledJobTimeoutMs,
      slowLlmConcurrency,
      fastConcurrency,
      embedConcurrency,
    };
  },
).describe("Memory background job processing configuration");

export const MemoryRetentionConfigSchema = z
  .object({
    keepRawForever: z
      .boolean({ error: "memory.retention.keepRawForever must be a boolean" })
      .default(true)
      .describe(
        "Whether to retain raw conversation data indefinitely (if false, raw data may be cleaned up after processing)",
      ),
  })
  .describe("Controls how long raw memory data is retained");

export const MemoryCleanupConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.cleanup.enabled must be a boolean" })
      .default(true)
      .describe("Whether periodic memory cleanup is enabled"),
    enqueueIntervalMs: z
      .number({ error: "memory.cleanup.enqueueIntervalMs must be a number" })
      .int("memory.cleanup.enqueueIntervalMs must be an integer")
      .positive("memory.cleanup.enqueueIntervalMs must be a positive integer")
      .default(6 * 60 * 60 * 1000)
      .describe("How often cleanup jobs are enqueued in milliseconds"),
    supersededItemRetentionMs: z
      .number({
        error: "memory.cleanup.supersededItemRetentionMs must be a number",
      })
      .int("memory.cleanup.supersededItemRetentionMs must be an integer")
      .positive(
        "memory.cleanup.supersededItemRetentionMs must be a positive integer",
      )
      .default(30 * 24 * 60 * 60 * 1000)
      .describe(
        "How long to keep superseded memory items before deleting them (ms)",
      ),
    conversationRetentionDays: z
      .number({
        error: "memory.cleanup.conversationRetentionDays must be a number",
      })
      .int("memory.cleanup.conversationRetentionDays must be an integer")
      .nonnegative(
        "memory.cleanup.conversationRetentionDays must be non-negative",
      )
      .default(0)
      .describe(
        "Number of days to retain conversation data before cleanup (0 disables pruning)",
      ),
    llmRequestLogRetentionMs: z
      .number({
        error: "memory.cleanup.llmRequestLogRetentionMs must be a number",
      })
      .int("memory.cleanup.llmRequestLogRetentionMs must be an integer")
      .nonnegative(
        "memory.cleanup.llmRequestLogRetentionMs must be non-negative",
      )
      // Upper bound must match gateway MAX_LLM_REQUEST_LOG_RETENTION_MS in
      // gateway/src/http/routes/privacy-config.ts. If a manually edited
      // config.json sets a value larger than this, the gateway GET would
      // return it and the macOS picker would snap it to its largest known
      // option, and the next PATCH would silently truncate the value —
      // causing quiet data loss. Enforcing the same cap here prevents the
      // daemon from accepting out-of-range values in the first place.
      .max(
        365 * 24 * 60 * 60 * 1000,
        "memory.cleanup.llmRequestLogRetentionMs must be <= 365 days in ms",
      )
      .nullable()
      .default(1 * 60 * 60 * 1000)
      .describe(
        "Retention period for LLM request/response logs in milliseconds (null keeps forever, 0 prunes immediately)",
      ),
  })
  .describe("Automatic memory cleanup and garbage collection settings");

export type MemoryJobsConfig = z.infer<typeof MemoryJobsConfigSchema>;
export type MemoryRetentionConfig = z.infer<typeof MemoryRetentionConfigSchema>;
export type MemoryCleanupConfig = z.infer<typeof MemoryCleanupConfigSchema>;
