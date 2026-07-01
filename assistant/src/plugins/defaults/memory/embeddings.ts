import { getConfig } from "../../../config/loader.js";
import {
  embedWithBackend as embedWithBackendWithConfig,
  selectedBackendSupportsMultimodal as selectedBackendSupportsMultimodalWithConfig,
} from "../../../persistence/embeddings/embedding-backend.js";
import type {
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "../../../persistence/embeddings/embedding-types.js";
import { resolveQdrantUrl as resolveQdrantUrlWithConfig } from "../../../persistence/embeddings/qdrant-client.js";
import { embedAndUpsert as embedAndUpsertWithConfig } from "../../../persistence/job-utils.js";

/**
 * Memory-internal accessor for the shared embeddings / vector subsystem.
 *
 * The embeddings operations live in `persistence/embeddings` and take the full
 * `AssistantConfig` as their first argument — they read both the `memory` slice
 * (Qdrant collection and vector settings) and the `llm` slice (embedding-backend
 * selection). Memory code reaches those operations through this accessor, which
 * resolves the live config internally, so the feature's call sites neither hold
 * nor thread `AssistantConfig` just to embed.
 */

type EmbeddingTargetType = Parameters<typeof embedAndUpsertWithConfig>[1];

/** Embed a target and upsert its vector to Qdrant. */
export function embedAndUpsert(
  targetType: EmbeddingTargetType,
  targetId: string,
  input: EmbeddingInput,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  return embedAndUpsertWithConfig(
    getConfig(),
    targetType,
    targetId,
    input,
    extraPayload,
  );
}

/** Embed one or more inputs via the selected embedding backend. */
export function embedWithBackend(
  inputs: EmbeddingInput[],
  options?: EmbeddingRequestOptions,
): ReturnType<typeof embedWithBackendWithConfig> {
  return embedWithBackendWithConfig(getConfig(), inputs, options);
}

/** Whether the active embedding backend handles multimodal inputs. */
export function selectedBackendSupportsMultimodal(): Promise<boolean> {
  return selectedBackendSupportsMultimodalWithConfig(getConfig());
}

/** Resolve the Qdrant base URL for this process. */
export function resolveQdrantUrl(): string {
  return resolveQdrantUrlWithConfig(getConfig());
}
