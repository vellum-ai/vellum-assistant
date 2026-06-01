// Persist per-conversation dismissed/completed surface IDs to localStorage so
// surfaces embedded in message history can be safely rehydrated on page reload
// without blocking the composer with surfaces the user has already resolved.
//
// The daemon emits ui_surface_show / ui_surface_dismiss / ui_surface_complete
// as transient SSE events and does not replay them on reconnect. Without a
// persisted "resolved" set on the client, historical surfaces would either
// (a) reappear as active on reload and wedge the composer, or (b) disappear
// entirely even if still pending. We persist resolved IDs here so rehydration
// can filter them out safely.

import type { DisplayMessage } from "@/domains/chat/types/types";
import { isStringArray } from "@/domains/chat/utils/storage-validators";
import { createRecordStorageAccessor } from "@/utils/typed-storage";

const MAX_IDS_PER_CONVERSATION = 500;

const storage = createRecordStorageAccessor<string[]>({
  keyFn: (assistantId) => `vellum:dismissed-surfaces:${assistantId}`,
  scope: "user",
  parseValue: (value) => (isStringArray(value) ? value : null),
  fallback: {},
  maxEntries: 200,
});

export function loadDismissedSurfaceIds(
  assistantId: string,
  conversationId: string,
): Set<string> {
  const ids = storage.get(assistantId, conversationId);
  return ids ? new Set(ids) : new Set();
}

export function saveDismissedSurfaceIds(
  assistantId: string,
  conversationId: string,
  ids: Set<string>,
): void {
  let idArray = Array.from(ids);
  if (idArray.length > MAX_IDS_PER_CONVERSATION) {
    idArray = idArray.slice(idArray.length - MAX_IDS_PER_CONVERSATION);
  }
  storage.set(assistantId, conversationId, idArray);
}

// Strip any surfaces (and matching contentOrder entries) whose IDs the user
// has already dismissed locally. Used when rehydrating message history so
// resolved surfaces don't reappear as active and block the composer.
//
// Returns the input array by reference when there is nothing to filter
// (empty dismissed set, or no surfaces match), so callers can use identity
// comparison to detect no-op cases.
export function filterDismissedSurfaces(
  messages: DisplayMessage[],
  dismissed: ReadonlySet<string>,
): DisplayMessage[] {
  if (dismissed.size === 0) return messages;
  let changed = false;
  const next = messages.map((msg) => {
    if (!msg.surfaces || msg.surfaces.length === 0) return msg;
    const filteredSurfaces = msg.surfaces.filter(
      (s) => !dismissed.has(s.surfaceId),
    );
    if (filteredSurfaces.length === msg.surfaces.length) return msg;
    changed = true;
    return {
      ...msg,
      surfaces: filteredSurfaces,
      contentOrder: msg.contentOrder?.filter(
        (e) => !(e.type === "surface" && dismissed.has(e.id)),
      ),
    };
  });
  return changed ? next : messages;
}
