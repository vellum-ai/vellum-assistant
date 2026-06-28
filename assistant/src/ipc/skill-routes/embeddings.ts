/**
 * Skill IPC route for the `host.embeddings.*` facet.
 *
 * A thin pass-through to the shared embeddings facet builder (see
 * {@link buildEmbeddingsFacet}). The host resolves the active embedding backend
 * from config; only the input texts cross the wire (the `AbortSignal` an
 * in-process caller could pass is process-local and does not serialize, so the
 * IPC surface omits it). Returns one dense vector per input, in input order.
 */

import { z } from "zod";

import { buildEmbeddingsFacet } from "../../daemon/skill-host-facets.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

// -- Param schemas --------------------------------------------------------

const EmbeddingsEmbedParams = z.object({
  texts: z.array(z.string()),
});

// -- Handlers -------------------------------------------------------------

async function handleEmbed(
  params?: Record<string, unknown>,
): Promise<number[][]> {
  const { texts } = EmbeddingsEmbedParams.parse(params);
  return buildEmbeddingsFacet().embed(texts);
}

// -- Route definitions ----------------------------------------------------

export const embeddingsEmbedRoute: SkillIpcRoute = {
  method: "host.embeddings.embed",
  handler: handleEmbed,
};

/** All `host.embeddings.*` IPC routes. */
export const embeddingsSkillRoutes: SkillIpcRoute[] = [embeddingsEmbedRoute];
