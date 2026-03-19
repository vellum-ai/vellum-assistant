import { z } from "zod";

export const VALID_MEMORY_EMBEDDING_PROVIDERS = [
  "auto",
  "local",
  "openai",
  "gemini",
  "ollama",
] as const;

const VALID_QDRANT_QUANTIZATION = ["scalar", "none"] as const;

export const MemoryEmbeddingsConfigSchema = z
  .object({
    required: z
      .boolean({ error: "memory.embeddings.required must be a boolean" })
      .default(true)
      .describe(
        "Whether embedding generation is required for memory to function (if false, memory works without embeddings)",
      ),
    provider: z
      .enum(VALID_MEMORY_EMBEDDING_PROVIDERS, {
        error: `memory.embeddings.provider must be one of: ${VALID_MEMORY_EMBEDDING_PROVIDERS.join(
          ", ",
        )}`,
      })
      .default("auto")
      .describe(
        "Embedding provider — 'auto' selects the best available provider",
      ),
    localModel: z
      .string({ error: "memory.embeddings.localModel must be a string" })
      .default("Xenova/bge-small-en-v1.5")
      .describe("Model name for the local (in-process) embedding provider"),
    openaiModel: z
      .string({ error: "memory.embeddings.openaiModel must be a string" })
      .default("text-embedding-3-small")
      .describe("Model name for the OpenAI embedding provider"),
    geminiModel: z
      .string({ error: "memory.embeddings.geminiModel must be a string" })
      .default("gemini-embedding-2-preview")
      .describe("Model name for the Gemini embedding provider"),
    geminiTaskType: z
      .enum(
        [
          "SEMANTIC_SIMILARITY",
          "CLASSIFICATION",
          "CLUSTERING",
          "RETRIEVAL_DOCUMENT",
          "RETRIEVAL_QUERY",
          "CODE_RETRIEVAL_QUERY",
          "QUESTION_ANSWERING",
          "FACT_VERIFICATION",
        ],
        { error: "memory.embeddings.geminiTaskType must be a valid task type" },
      )
      .optional()
      .describe("Gemini-specific task type hint for embedding generation"),
    geminiDimensions: z
      .number({ error: "memory.embeddings.geminiDimensions must be a number" })
      .int("memory.embeddings.geminiDimensions must be an integer")
      .min(128, "memory.embeddings.geminiDimensions must be >= 128")
      .max(3072, "memory.embeddings.geminiDimensions must be <= 3072")
      .optional()
      .describe("Output dimensionality for Gemini embeddings"),
    ollamaModel: z
      .string({ error: "memory.embeddings.ollamaModel must be a string" })
      .default("nomic-embed-text")
      .describe("Model name for the Ollama embedding provider"),
  })
  .describe("Embedding generation configuration for semantic memory search");

export const QdrantConfigSchema = z
  .object({
    url: z
      .string({ error: "memory.qdrant.url must be a string" })
      .default("http://127.0.0.1:6333")
      .describe("URL of the Qdrant vector database instance"),
    collection: z
      .string({ error: "memory.qdrant.collection must be a string" })
      .default("memory")
      .describe("Name of the Qdrant collection used for memory storage"),
    vectorSize: z
      .number({ error: "memory.qdrant.vectorSize must be a number" })
      .int("memory.qdrant.vectorSize must be an integer")
      .positive("memory.qdrant.vectorSize must be a positive integer")
      .default(384)
      .describe("Dimensionality of the embedding vectors stored in Qdrant"),
    onDisk: z
      .boolean({ error: "memory.qdrant.onDisk must be a boolean" })
      .default(true)
      .describe("Whether to store vector data on disk rather than in memory"),
    quantization: z
      .enum(VALID_QDRANT_QUANTIZATION, {
        error: `memory.qdrant.quantization must be one of: ${VALID_QDRANT_QUANTIZATION.join(
          ", ",
        )}`,
      })
      .default("scalar")
      .describe(
        "Vector quantization method — 'scalar' reduces memory usage, 'none' keeps full precision",
      ),
  })
  .describe("Qdrant vector database configuration for memory storage");

export const MemorySegmentationConfigSchema = z
  .object({
    targetTokens: z
      .number({ error: "memory.segmentation.targetTokens must be a number" })
      .int("memory.segmentation.targetTokens must be an integer")
      .positive("memory.segmentation.targetTokens must be a positive integer")
      .default(450)
      .describe("Target number of tokens per memory segment"),
    overlapTokens: z
      .number({ error: "memory.segmentation.overlapTokens must be a number" })
      .int("memory.segmentation.overlapTokens must be an integer")
      .nonnegative(
        "memory.segmentation.overlapTokens must be a non-negative integer",
      )
      .default(60)
      .describe(
        "Number of overlapping tokens between adjacent segments for context continuity",
      ),
  })
  .describe(
    "Controls how conversation text is split into segments for embedding and storage",
  );

export type MemoryEmbeddingsConfig = z.infer<
  typeof MemoryEmbeddingsConfigSchema
>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type MemorySegmentationConfig = z.infer<
  typeof MemorySegmentationConfigSchema
>;
