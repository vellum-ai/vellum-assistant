/**
 * Thin wrapper over the daemon `POST /memory/remember` route. The daemon spec
 * transform rewrites `/v1/memory/remember` → `/v1/assistants/{assistant_id}/…`,
 * so the assistant id travels in the path. Appends a user-authored fact to the
 * memory buffer via `handleRemember`; the graph renders buffered facts as
 * `pending` nodes, so callers should invalidate the memory-graph query to
 * surface it immediately. The route also nudges a consolidation run that
 * files the fact into a concept page. Mirrors the thin-wrapper style of the
 * sibling `get-memory-graph.ts` / `get-memory-graph-node.ts` read helpers.
 */

import { memoryRememberPost } from "@/generated/daemon/sdk.gen";

export interface CreateMemoryResult {
  message: string;
  success: boolean;
  /** Graph node id (`buffer:<hash>`) of the pending entry this create
   * appended, for fly-to-node navigation. Absent on daemons predating the
   * field or when the server couldn't re-read the buffer. */
  pendingNodeId?: string;
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
