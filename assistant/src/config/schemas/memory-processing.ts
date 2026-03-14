import { z } from "zod";

export const MemoryExtractionConfigSchema = z.object({
  useLLM: z
    .boolean({ error: "memory.extraction.useLLM must be a boolean" })
    .default(true),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "memory.extraction.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
  extractFromAssistant: z
    .boolean({
      error: "memory.extraction.extractFromAssistant must be a boolean",
    })
    .default(true),
});

export const MemorySummarizationConfigSchema = z.object({
  useLLM: z
    .boolean({ error: "memory.summarization.useLLM must be a boolean" })
    .default(true),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "memory.summarization.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
});

export type MemoryExtractionConfig = z.infer<
  typeof MemoryExtractionConfigSchema
>;
export type MemorySummarizationConfig = z.infer<
  typeof MemorySummarizationConfigSchema
>;
