import { z } from "zod";

export const MemoryRetrospectiveConfigSchema = z
  .object({
    timeThresholdMs: z
      .number({
        error: "memory.retrospective.timeThresholdMs must be a number",
      })
      .int("memory.retrospective.timeThresholdMs must be an integer")
      .positive(
        "memory.retrospective.timeThresholdMs must be a positive integer",
      )
      .default(30 * 60 * 1000)
      .describe(
        "Milliseconds since the last retrospective attempt before the interval trigger fires.",
      ),

    messageThreshold: z
      .number({
        error: "memory.retrospective.messageThreshold must be a number",
      })
      .int("memory.retrospective.messageThreshold must be an integer")
      .positive(
        "memory.retrospective.messageThreshold must be a positive integer",
      )
      .default(10)
      .describe(
        "New messages since the last successful retrospective run before the message-count trigger fires.",
      ),

    minCooldownMs: z
      .number({ error: "memory.retrospective.minCooldownMs must be a number" })
      .int("memory.retrospective.minCooldownMs must be an integer")
      .nonnegative(
        "memory.retrospective.minCooldownMs must be a non-negative integer",
      )
      .default(5 * 60 * 1000)
      .describe(
        "Minimum milliseconds between attempts (success or failure). Prevents tight retry loops across trigger types. Pre-compaction bypasses this gate.",
      ),
  })
  .describe(
    "Controls the memory-retrospective background pass triggered by the `memory-retrospective` feature flag. Model selection lives under llm.callSites.memoryRetrospective.",
  );

export type MemoryRetrospectiveConfig = z.infer<
  typeof MemoryRetrospectiveConfigSchema
>;
