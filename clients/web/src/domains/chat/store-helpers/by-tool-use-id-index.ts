/**
 * Shared spawn-anchor index helpers.
 *
 * Several background-process stores (workflow, subagent, ACP) keep a
 * `byToolUseId` index — a `Map<toolUseId, entryId>` — so the transcript can
 * anchor an inline card to the exact tool-use that spawned the run.
 */

/**
 * Set `toolUseId -> id` in the index.
 *
 * Returns the **same** Map reference when nothing would change — i.e. when
 * `toolUseId` is absent, or when it is already mapped to `id`. Otherwise
 * returns a new Map with the mapping applied.
 */
export function setToolUseAnchor(
  index: Map<string, string>,
  toolUseId: string | undefined,
  id: string,
): Map<string, string> {
  if (!toolUseId) return index;
  if (index.get(toolUseId) === id) return index;
  return new Map(index).set(toolUseId, id);
}

/**
 * Remove `toolUseId` from the index.
 *
 * Returns the **same** Map reference when nothing would change — i.e. when
 * `toolUseId` is absent or not present in the index. Otherwise returns a new
 * Map with the entry removed.
 */
export function clearToolUseAnchor(
  index: Map<string, string>,
  toolUseId: string | undefined,
): Map<string, string> {
  if (!toolUseId) return index;
  if (!index.has(toolUseId)) return index;
  const next = new Map(index);
  next.delete(toolUseId);
  return next;
}
