import { isAssistantFeatureFlagEnabled } from "../../../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../../../config/types.js";

/**
 * Feature flag gating the memory concept graph — the identity-page graph and
 * the backend-agnostic `/memory-graph` + `/memory-graph-node` routes that feed
 * it. Default off; when off the endpoints report `supported: false` and the
 * identity page falls back to the skills constellation.
 */
export const MEMORY_CONCEPT_GRAPH_FLAG = "memory-concept-graph" as const;

export function isMemoryConceptGraphEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(MEMORY_CONCEPT_GRAPH_FLAG, config);
}
