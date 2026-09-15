// Persist user-dismissed "Connect Claude Code" tool-use ids so a card the user
// retired without connecting does not come back from history on reload.
//
// The prompt is derived from a failed `acp_spawn`'s persisted `errorCode`
// marker, which stays in conversation history after the user walks away. The
// in-memory dismissed set is enough for the current page; this list is what a
// cold load consults before re-raising that same failed spawn. Scoped to the
// tool-use id, so a later spawn (fresh id) still raises a card. Cleared on
// logout with the rest of the `vellum:` user-scoped keys.

import { parseStringArray } from "@/domains/chat/utils/storage-validators";
import { createStorageAccessor } from "@/utils/typed-storage";

const MAX_IDS = 500;

const storage = createStorageAccessor<string[]>({
  key: "vellum:dismissed-acp-connect",
  scope: "user",
  parse: parseStringArray,
  serialize: JSON.stringify,
  fallback: [],
});

export function loadDismissedAcpConnectIds(): Set<string> {
  return new Set(storage.load());
}

export function addDismissedAcpConnectId(toolUseId: string): void {
  const current = storage.load();
  if (current.includes(toolUseId)) {
    return;
  }
  const next = [...current, toolUseId];
  storage.save(
    next.length > MAX_IDS ? next.slice(next.length - MAX_IDS) : next,
  );
}

export function removeDismissedAcpConnectId(toolUseId: string): void {
  const current = storage.load();
  if (!current.includes(toolUseId)) {
    return;
  }
  storage.save(current.filter((id) => id !== toolUseId));
}
