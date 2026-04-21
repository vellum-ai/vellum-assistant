import { z } from "zod";

export const MemoryExtractionConfigSchema = z
  .object({
    useLLM: z
      .boolean({ error: "memory.extraction.useLLM must be a boolean" })
      .default(true)
      .describe(
        "Whether to use an LLM for extracting structured memory items from conversations",
      ),
    extractFromAssistant: z
      .boolean({
        error: "memory.extraction.extractFromAssistant must be a boolean",
      })
      .default(true)
      .describe(
        "Whether to extract memory items from the assistant's own messages (in addition to user messages)",
      ),
    batchSize: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe(
        "Number of unextracted messages before triggering batch extraction",
      ),
    idleTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(300000)
      .describe(
        "Milliseconds of idle time before triggering extraction of pending messages",
      ),
  })
  .describe("Controls how memory items are extracted from conversations");

export const MemorySummarizationConfigSchema = z
  .object({
    useLLM: z
      .boolean({ error: "memory.summarization.useLLM must be a boolean" })
      .default(true)
      .describe(
        "Whether to use an LLM for summarizing and consolidating memory items",
      ),
  })
  .describe(
    "Controls how memory items are summarized and consolidated over time. Model selection lives under llm.callSites.conversationSummarization.",
  );

export type MemoryExtractionConfig = z.infer<
  typeof MemoryExtractionConfigSchema
>;
export type MemorySummarizationConfig = z.infer<
  typeof MemorySummarizationConfigSchema
>;
