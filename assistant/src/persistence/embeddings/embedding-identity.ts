import { QdrantClient } from "@qdrant/js-client-rest";

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import {
  resolveBackendDimension,
  selectEmbeddingBackend,
} from "./embedding-backend.js";
import { isEmbeddingBillingBreakerOpen } from "./embedding-billing-breaker.js";
import type { EmbeddingProviderName } from "./embedding-types.js";
import { resolveQdrantUrl } from "./qdrant-client.js";

const log = getLogger("embedding-identity");

// Inlined rather than imported from `memory/v2/qdrant.ts`: the persistence
// layer must not import from the memory feature layer (enforced by
// persistence-layering-guard). The dependency direction is memory → persistence.
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
 *   - backend selection throws (e.g. a transient credential-store error);
 *   - the measurement probe throws (provider unreachable).
 *
 * Delegates the dimension measurement to {@link resolveBackendDimension}, the
 * single memoized source of truth shared with the per-query availability check,
 * so the reconcile pays at most one embed round-trip per (provider, model) and
 * cannot disagree with the read-lane probe.
 */
export async function probeBackendDimension(
  config: AssistantConfig,
): Promise<BackendDimensionProbe | null> {
  if (isEmbeddingBillingBreakerOpen()) return null;

  try {
    const { backend } = await selectEmbeddingBackend(config);
    if (!backend) return null;

    const dim = await resolveBackendDimension(backend);
    if (dim == null) return null;
    return { provider: backend.provider, model: backend.model, dim };
  } catch (err) {
    // `selectEmbeddingBackend` resolves provider credentials and can reject on a
    // non-timeout credential-store error; the reconcile relies on a null return
    // to defer, so honor the never-throws contract and treat it as degraded.
    log.warn({ err }, "Embedding-dimension probe failed; treating as degraded");
    return null;
  }
}

/**
 * Read the committed dense-vector dimension of the v2 concept-page collection.
 *
 * Returns `null` ONLY for a CONFIRMED-absent collection (a fresh install). Any
 * other inability to read the committed dimension THROWS rather than returning
 * `null`:
 *   - a transient Qdrant failure (`collectionExists`/`getCollection` rejects)
 *     propagates, so a brief outage is not misread as "no collection";
 *   - an existing collection whose dense-vector size cannot be read is an error
 *     too, so "unknown" never masquerades as "fresh".
 *
 * The reconcile treats `null` as a fresh install (→ commit the probed dim), so
 * conflating "unreachable" with "absent" would persist a new dimension while the
 * old collection still exists at the old size. The reconcile catches the throw
 * and defers instead.
 */
export async function readConceptPageCollectionDim(
  config: AssistantConfig,
): Promise<number | null> {
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
  if (typeof size !== "number") {
    throw new Error(
      `v2 concept-page collection "${MEMORY_V2_COLLECTION}" exists but its dense-vector size is unreadable`,
    );
  }
  return size;
}
