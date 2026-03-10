import { z } from "zod";

export const MemoryJobsConfigSchema = z.object({
  workerConcurrency: z
    .number({ error: "memory.jobs.workerConcurrency must be a number" })
    .int("memory.jobs.workerConcurrency must be an integer")
    .positive("memory.jobs.workerConcurrency must be a positive integer")
    .default(2),
  batchSize: z
    .number({ error: "memory.jobs.batchSize must be a number" })
    .int("memory.jobs.batchSize must be an integer")
    .positive("memory.jobs.batchSize must be a positive integer")
    .default(10),
  stalledJobTimeoutMs: z
    .number({ error: "memory.jobs.stalledJobTimeoutMs must be a number" })
    .int("memory.jobs.stalledJobTimeoutMs must be an integer")
    .positive("memory.jobs.stalledJobTimeoutMs must be a positive integer")
    .default(30 * 60 * 1000),
});

export const MemoryRetentionConfigSchema = z.object({
  keepRawForever: z
    .boolean({ error: "memory.retention.keepRawForever must be a boolean" })
    .default(true),
});

export const MemoryCleanupConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.cleanup.enabled must be a boolean" })
    .default(true),
  enqueueIntervalMs: z
    .number({ error: "memory.cleanup.enqueueIntervalMs must be a number" })
    .int("memory.cleanup.enqueueIntervalMs must be an integer")
    .positive("memory.cleanup.enqueueIntervalMs must be a positive integer")
    .default(6 * 60 * 60 * 1000),
  resolvedConflictRetentionMs: z
    .number({
      error: "memory.cleanup.resolvedConflictRetentionMs must be a number",
    })
    .int("memory.cleanup.resolvedConflictRetentionMs must be an integer")
    .positive(
      "memory.cleanup.resolvedConflictRetentionMs must be a positive integer",
    )
    .default(30 * 24 * 60 * 60 * 1000),
  supersededItemRetentionMs: z
    .number({
      error: "memory.cleanup.supersededItemRetentionMs must be a number",
    })
    .int("memory.cleanup.supersededItemRetentionMs must be an integer")
    .positive(
      "memory.cleanup.supersededItemRetentionMs must be a positive integer",
    )
    .default(30 * 24 * 60 * 60 * 1000),
  conversationRetentionDays: z
    .number({
      error: "memory.cleanup.conversationRetentionDays must be a number",
    })
    .int("memory.cleanup.conversationRetentionDays must be an integer")
    .nonnegative(
      "memory.cleanup.conversationRetentionDays must be non-negative",
    )
    .default(90),
});

export type MemoryJobsConfig = z.infer<typeof MemoryJobsConfigSchema>;
export type MemoryRetentionConfig = z.infer<typeof MemoryRetentionConfigSchema>;
export type MemoryCleanupConfig = z.infer<typeof MemoryCleanupConfigSchema>;
