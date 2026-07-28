import { getConfig } from "../../../config/loader.js";
import type { AssistantConfig } from "../../../config/types.js";
import type {
  EmbeddingInput,
  EmbeddingRequestOptions,
} from "../../../persistence/embeddings/embedding-types.js";
import { resolveQdrantUrl as resolveQdrantUrlWithConfig } from "../../../persistence/embeddings/qdrant-client.js";

/**
 * Memory-internal accessor for the embeddings operations that stay off
 * `@vellumai/plugin-api` (the self-contained ops live there — see
 * `persistence/embeddings/plugin-facade.ts`).
 *
 * `embedWithBackend` keeps its `config` parameter — it is a primitive whose
 * vectors the caller stores alongside its own config-derived metadata (cache
 * keys, vector-size checks, Qdrant collection), so it must embed with the
 * caller's exact config snapshot rather than a re-read that could diverge from
 * that metadata mid-operation. It is loaded via dynamic `import()` inside the
 * wrapper so importing this module does not eagerly pull the embed graph
 * (`embedding-backend`), which would break intentional partial module mocks
 * in memory tests. `resolveQdrantUrl` is synchronous — its consumers are
 * memoized client getters — so it is imported statically.
 */

/** Embed one or more inputs via the selected embedding backend. */
export async function embedWithBackend(
  config: AssistantConfig,
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
  return withConfig(config, inputs, options);
}

/** Resolve the Qdrant base URL for this process. */
export function resolveQdrantUrl(): string {
  return resolveQdrantUrlWithConfig(getConfig());
}
