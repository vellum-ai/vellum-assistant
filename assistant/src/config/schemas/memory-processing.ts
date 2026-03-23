import { z } from "zod";

export const MemoryExtractionConfigSchema = z
  .object({
    useLLM: z
      .boolean({ error: "memory.extraction.useLLM must be a boolean" })
      .default(true)
      .describe(
        "Whether to use an LLM for extracting structured memory items from conversations",
      ),
    modelIntent: z
      .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
        error: "memory.extraction.modelIntent must be a valid model intent",
      })
      .default("quality-optimized")
      .describe(
        "Model selection strategy for extraction — trade off speed vs quality",
      ),
    extractFromAssistant: z
      .boolean({
        error: "memory.extraction.extractFromAssistant must be a boolean",
      })
      .default(true)
      .describe(
        "Whether to extract memory items from the assistant's own messages (in addition to user messages)",
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
    modelIntent: z
      .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
        error: "memory.summarization.modelIntent must be a valid model intent",
      })
      .default("quality-optimized")
      .describe(
        "Model selection strategy for summarization — trade off speed vs quality",
      ),
  })
  .describe(
    "Controls how memory items are summarized and consolidated over time",
  );

export type MemoryExtractionConfig = z.infer<
  typeof MemoryExtractionConfigSchema
>;
export type MemorySummarizationConfig = z.infer<
  typeof MemorySummarizationConfigSchema
>;
