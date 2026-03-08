import { z } from "zod";

const VALID_MEMORY_EMBEDDING_PROVIDERS = [
  "auto",
  "local",
  "openai",
  "gemini",
  "ollama",
] as const;

const VALID_QDRANT_QUANTIZATION = ["scalar", "none"] as const;

export const MemoryEmbeddingsConfigSchema = z.object({
  required: z
    .boolean({ error: "memory.embeddings.required must be a boolean" })
    .default(true),
  provider: z
    .enum(VALID_MEMORY_EMBEDDING_PROVIDERS, {
      error: `memory.embeddings.provider must be one of: ${VALID_MEMORY_EMBEDDING_PROVIDERS.join(
        ", ",
      )}`,
    })
    .default("auto"),
  localModel: z
    .string({ error: "memory.embeddings.localModel must be a string" })
    .default("Xenova/bge-small-en-v1.5"),
  openaiModel: z
    .string({ error: "memory.embeddings.openaiModel must be a string" })
    .default("text-embedding-3-small"),
  geminiModel: z
    .string({ error: "memory.embeddings.geminiModel must be a string" })
    .default("gemini-embedding-001"),
  ollamaModel: z
    .string({ error: "memory.embeddings.ollamaModel must be a string" })
    .default("nomic-embed-text"),
});

export const QdrantConfigSchema = z.object({
  url: z
    .string({ error: "memory.qdrant.url must be a string" })
    .default("http://127.0.0.1:6333"),
  collection: z
    .string({ error: "memory.qdrant.collection must be a string" })
    .default("memory"),
  vectorSize: z
    .number({ error: "memory.qdrant.vectorSize must be a number" })
    .int("memory.qdrant.vectorSize must be an integer")
    .positive("memory.qdrant.vectorSize must be a positive integer")
    .default(384),
  onDisk: z
    .boolean({ error: "memory.qdrant.onDisk must be a boolean" })
    .default(true),
  quantization: z
    .enum(VALID_QDRANT_QUANTIZATION, {
      error: `memory.qdrant.quantization must be one of: ${VALID_QDRANT_QUANTIZATION.join(
        ", ",
      )}`,
    })
    .default("scalar"),
});

export const MemorySegmentationConfigSchema = z.object({
  targetTokens: z
    .number({ error: "memory.segmentation.targetTokens must be a number" })
    .int("memory.segmentation.targetTokens must be an integer")
    .positive("memory.segmentation.targetTokens must be a positive integer")
    .default(450),
  overlapTokens: z
    .number({ error: "memory.segmentation.overlapTokens must be a number" })
    .int("memory.segmentation.overlapTokens must be an integer")
    .nonnegative(
      "memory.segmentation.overlapTokens must be a non-negative integer",
    )
    .default(60),
});

export type MemoryEmbeddingsConfig = z.infer<
  typeof MemoryEmbeddingsConfigSchema
>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type MemorySegmentationConfig = z.infer<
  typeof MemorySegmentationConfigSchema
>;
