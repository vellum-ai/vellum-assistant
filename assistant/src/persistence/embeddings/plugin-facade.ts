import { getConfig } from "../../config/loader.js";
import type { EmbeddingInput } from "./embedding-types.js";

/**
 * Plugin-facing facade over the embeddings subsystem: self-contained
 * operations that resolve the live workspace config internally, so callers
 * (plugins importing via `@vellumai/plugin-api`) hold no host config.
 *
 * The operations are loaded via dynamic `import()` inside each wrapper so
 * that importing this module — which every `@vellumai/plugin-api` consumer
 * does transitively — does not eagerly pull the embed/vector import graph
 * (`job-utils`, `embedding-backend`). An eager pull would force those
 * modules' named exports to resolve at instantiation, which breaks the
 * intentional partial module mocks in tests.
 */

type EmbeddingTargetType = Parameters<
  typeof import("../job-utils.js").embedAndUpsert
>[1];

/** Embed a target and upsert its vector into the vector store. */
export async function embedAndUpsert(
  targetType: EmbeddingTargetType,
  targetId: string,
  input: EmbeddingInput,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const { embedAndUpsert: withConfig } = await import("../job-utils.js");
  return withConfig(getConfig(), targetType, targetId, input, extraPayload);
}

/** Whether the active embedding backend handles multimodal inputs. */
export async function selectedBackendSupportsMultimodal(): Promise<boolean> {
  const { selectedBackendSupportsMultimodal: withConfig } =
    await import("./embedding-backend.js");
  return withConfig(getConfig());
}
