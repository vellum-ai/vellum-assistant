import { getConfig } from "../../../config/loader.js";
import type {
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "../../../persistence/embeddings/embedding-types.js";
import { resolveQdrantUrl as resolveQdrantUrlWithConfig } from "../../../persistence/embeddings/qdrant-client.js";

/**
 * Memory-internal accessor for the shared embeddings / vector subsystem.
 *
 * The embeddings operations live in `persistence/embeddings` (and
 * `persistence/job-utils`) and take the full `AssistantConfig` as their first
 * argument — they read both the `memory` slice (Qdrant collection and vector
 * settings) and the `llm` slice (embedding-backend selection). Memory code
 * reaches those operations through this accessor, which resolves the live config
 * internally, so the feature's call sites neither hold nor thread
 * `AssistantConfig` just to embed.
 *
 * The embed operations are loaded via dynamic `import()` inside each wrapper so
 * that importing this module for a single operation does not eagerly pull the
 * whole embed/vector import graph (`job-utils`, `embedding-backend`) into the
 * consumer. An eager pull would force every one of those modules' named exports
 * to resolve at instantiation, which breaks the intentional partial module
 * mocks in memory tests (a store that mocks only the exports it uses). Only the
 * synchronous `resolveQdrantUrl` is imported statically.
 */

type EmbeddingTargetType = Parameters<
  typeof import("../../../persistence/job-utils.js").embedAndUpsert
>[1];

/** Embed a target and upsert its vector to Qdrant. */
export async function embedAndUpsert(
  targetType: EmbeddingTargetType,
  targetId: string,
  input: EmbeddingInput,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const { embedAndUpsert: withConfig } =
    await import("../../../persistence/job-utils.js");
  return withConfig(getConfig(), targetType, targetId, input, extraPayload);
}

/** Embed one or more inputs via the selected embedding backend. */
export async function embedWithBackend(
  inputs: EmbeddingInput[],
  options?: EmbeddingRequestOptions,
): Promise<
  Awaited<
    ReturnType<
      typeof import("../../../persistence/embeddings/embedding-backend.js").embedWithBackend
    >
  >
> {
  const { embedWithBackend: withConfig } =
    await import("../../../persistence/embeddings/embedding-backend.js");
  return withConfig(getConfig(), inputs, options);
}

/** Whether the active embedding backend handles multimodal inputs. */
export async function selectedBackendSupportsMultimodal(): Promise<boolean> {
  const { selectedBackendSupportsMultimodal: withConfig } =
    await import("../../../persistence/embeddings/embedding-backend.js");
  return withConfig(getConfig());
}

/** Resolve the Qdrant base URL for this process. */
export function resolveQdrantUrl(): string {
  return resolveQdrantUrlWithConfig(getConfig());
}
