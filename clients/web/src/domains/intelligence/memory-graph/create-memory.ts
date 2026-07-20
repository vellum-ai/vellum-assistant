/**
 * Thin wrapper over the daemon `POST /memory/remember` route. The daemon spec
 * transform rewrites `/v1/memory/remember` → `/v1/assistants/{assistant_id}/…`,
 * so the assistant id travels in the path. Appends a user-authored fact to the
 * memory buffer via `handleRemember`; consolidation materializes it into a
 * graph node LATER, so the new memory is not visible immediately — callers
 * should invalidate the memory-graph query and rely on the next consolidation
 * to surface the node. Mirrors the thin-wrapper style of the sibling
 * `get-memory-graph.ts` / `get-memory-graph-node.ts` read helpers.
 */

import { memoryRememberPost } from "@/generated/daemon/sdk.gen";

export interface CreateMemoryResult {
  message: string;
  success: boolean;
}

export async function createMemory(
  assistantId: string,
  content: string,
): Promise<CreateMemoryResult> {
  // `throwOnError: true` narrows `data` to the 200 body and throws on any
  // transport / non-2xx error, so the caller can `try/catch` and surface
  // `error.message` in a toast.
  const { data } = await memoryRememberPost({
    path: { assistant_id: assistantId },
    body: { content },
    throwOnError: true,
  });
  return data;
}
