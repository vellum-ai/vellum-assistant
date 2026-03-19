import { z } from "zod";

export const MemorySimplifiedBriefConfigSchema = z
  .object({
    maxTokens: z
      .number({
        error: "memory.simplified.brief.maxTokens must be a number",
      })
      .int("memory.simplified.brief.maxTokens must be an integer")
      .positive("memory.simplified.brief.maxTokens must be a positive integer")
      .default(4000)
      .describe(
        "Maximum token budget for the memory brief injected into conversation context",
      ),
  })
  .describe("Controls the memory brief that is injected into conversations");

export const MemorySimplifiedReducerConfigSchema = z
  .object({
    idleDelayMs: z
      .number({
        error: "memory.simplified.reducer.idleDelayMs must be a number",
      })
      .int("memory.simplified.reducer.idleDelayMs must be an integer")
      .positive(
        "memory.simplified.reducer.idleDelayMs must be a positive integer",
      )
      .default(30_000)
      .describe(
        "Milliseconds of idle time before the reducer processes new conversation turns into memory",
      ),
    switchWaitMs: z
      .number({
        error: "memory.simplified.reducer.switchWaitMs must be a number",
      })
      .int("memory.simplified.reducer.switchWaitMs must be an integer")
      .positive(
        "memory.simplified.reducer.switchWaitMs must be a positive integer",
      )
      .default(5_000)
      .describe(
        "Milliseconds to wait after a conversation switch before running the reducer",
      ),
  })
  .describe(
    "Controls when the memory reducer runs to process conversation turns into persistent memory",
  );

export const MemorySimplifiedArchiveRecallConfigSchema = z
  .object({
    maxSnippets: z
      .number({
        error: "memory.simplified.archiveRecall.maxSnippets must be a number",
      })
      .int("memory.simplified.archiveRecall.maxSnippets must be an integer")
      .positive(
        "memory.simplified.archiveRecall.maxSnippets must be a positive integer",
      )
      .default(10)
      .describe(
        "Maximum number of archive snippets to recall when supplementing the brief with semantic search",
      ),
  })
  .describe(
    "Controls how archived memory snippets are recalled via semantic search",
  );

export const MemorySimplifiedConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "memory.simplified.enabled must be a boolean",
      })
      .default(true)
      .describe("Whether the simplified memory system is enabled"),
    brief: MemorySimplifiedBriefConfigSchema.default(
      MemorySimplifiedBriefConfigSchema.parse({}),
    ),
    reducer: MemorySimplifiedReducerConfigSchema.default(
      MemorySimplifiedReducerConfigSchema.parse({}),
    ),
    archiveRecall: MemorySimplifiedArchiveRecallConfigSchema.default(
      MemorySimplifiedArchiveRecallConfigSchema.parse({}),
    ),
  })
  .describe(
    "Simplified two-layer memory system — a brief plus archive recall, replacing the legacy item/tier/staleness model",
  );

export type MemorySimplifiedConfig = z.infer<
  typeof MemorySimplifiedConfigSchema
>;
export type MemorySimplifiedBriefConfig = z.infer<
  typeof MemorySimplifiedBriefConfigSchema
>;
export type MemorySimplifiedReducerConfig = z.infer<
  typeof MemorySimplifiedReducerConfigSchema
>;
export type MemorySimplifiedArchiveRecallConfig = z.infer<
  typeof MemorySimplifiedArchiveRecallConfigSchema
>;
