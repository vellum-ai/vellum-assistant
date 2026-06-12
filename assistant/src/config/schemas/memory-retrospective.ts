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

    keepSupersededRuns: z
      .boolean({
        error: "memory.retrospective.keepSupersededRuns must be a boolean",
      })
      .default(false)
      .describe(
        "When false (default), superseded retrospective conversations are deleted once a newer run succeeds — dedup only ever reads the most recent run via findMostRecentRetrospectiveFor, so older runs are dead weight (fork-based runs each carry a full copy of the source conversation's messages). Operators who want to retain the full run history set this to true; retained runs also skip the startup orphan sweep so they survive restarts.",
      ),
  })
  .describe(
    "Controls the memory-retrospective background pass. Model selection lives under llm.callSites.memoryRetrospective.",
  );

export type MemoryRetrospectiveConfig = z.infer<
  typeof MemoryRetrospectiveConfigSchema
>;
