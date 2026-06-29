import { QdrantClient } from "@qdrant/js-client-rest";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { selectEmbeddingBackend } from "./embedding-backend.js";
import { isEmbeddingBillingBreakerOpen } from "./embedding-billing-breaker.js";
import {
  EMBEDDING_DIMENSION_PROBE_TEXT,
  type EmbeddingProviderName,
} from "./embedding-types.js";
import { resolveQdrantUrl } from "./qdrant-client.js";

const log = getLogger("embedding-identity");

const MEMORY_V2_COLLECTION = "memory_v2_concept_pages";

export interface BackendDimensionProbe {
  provider: EmbeddingProviderName;
  model: string;
  dim: number;
}

/**
 * Measure the output dimension of the currently selected embedding backend by
 * embedding a fixed probe string.
 *
 * Returns `null` — never throws — when the backend is unavailable, so the
 * reconcile defers rather than committing on a measurement it could not take:
 *   - the billing breaker is open (treated as "backend down");
 *   - no backend is configured/selectable;
 *   - the backend's `embed` call throws (provider unreachable).
 *
 * Calls `backend.embed` directly rather than `embedWithBackend`, which asserts
 * `config.memory.qdrant.vectorSize` and would throw on exactly the dimension
 * mismatch this probe is meant to measure. Calling the backend directly also
 * bypasses the in-memory vector cache, which this probe does not populate.
 */
export async function probeBackendDimension(
  config: AssistantConfig,
): Promise<BackendDimensionProbe | null> {
  if (isEmbeddingBillingBreakerOpen()) return null;

  const { backend } = await selectEmbeddingBackend(config);
  if (!backend) return null;

  try {
    const vectors = await backend.embed([EMBEDDING_DIMENSION_PROBE_TEXT]);
    const dim = vectors[0]?.length;
    if (dim == null) return null;
    return { provider: backend.provider, model: backend.model, dim };
  } catch (err) {
    log.warn(
      { err },
      "Backend dimension probe failed; treating as unavailable",
    );
    return null;
  }
}

/**
 * Read the committed dense-vector dimension of the v2 concept-page collection.
 *
 * Returns `null` — never throws — when the collection is absent or its schema
 * cannot be read, mirroring the "assume unknown on probe failure" posture in
 * `assistant/src/memory/v2/qdrant.ts`.
 */
export async function readConceptPageCollectionDim(
  config: AssistantConfig,
): Promise<number | null> {
  try {
    const client = new QdrantClient({
      url: resolveQdrantUrl(config),
      checkCompatibility: false,
    });
    const exists = await client.collectionExists(MEMORY_V2_COLLECTION);
    if (!exists.exists) return null;

    const info = await client.getCollection(MEMORY_V2_COLLECTION);
    const vectors = info.config?.params?.vectors as
      | Record<string, { size?: number } | undefined>
      | undefined;
    const size = vectors?.dense?.size;
    return typeof size === "number" ? size : null;
  } catch (err) {
    log.warn(
      { err, collection: MEMORY_V2_COLLECTION },
      "Failed to read v2 concept-page collection dimension; treating as unknown",
    );
    return null;
  }
}
