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
//
// Shape on disk: { [conversationKey]: string[] }, keyed per assistant.

import type { DisplayMessage } from "@/domains/chat/lib/types.js";

const STORAGE_KEY_PREFIX = "vellum:dismissed-surfaces:";
const MAX_ENTRIES_PER_ASSISTANT = 200;
const MAX_IDS_PER_CONVERSATION = 500;

type StoredMap = Record<string, string[]>;

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function safeParse(raw: string | null): StoredMap {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const result: StoredMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isStringArray(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function loadDismissedSurfaceIds(
  assistantId: string,
  conversationKey: string,
): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(storageKey(assistantId));
    const map = safeParse(raw);
    const ids = map[conversationKey];
    return ids ? new Set(ids) : new Set();
  } catch {
    return new Set();
  }
}

export function saveDismissedSurfaceIds(
  assistantId: string,
  conversationKey: string,
  ids: Set<string>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = storageKey(assistantId);
    const existing = safeParse(window.localStorage.getItem(key));

    // Cap per-conversation list size; drop oldest on overflow (insertion order).
    let idArray = Array.from(ids);
    if (idArray.length > MAX_IDS_PER_CONVERSATION) {
      idArray = idArray.slice(idArray.length - MAX_IDS_PER_CONVERSATION);
    }
    existing[conversationKey] = idArray;

    const entries = Object.entries(existing);
    if (entries.length > MAX_ENTRIES_PER_ASSISTANT) {
      const trimmed = entries.slice(entries.length - MAX_ENTRIES_PER_ASSISTANT);
      const trimmedMap: StoredMap = {};
      for (const [k, v] of trimmed) {
        trimmedMap[k] = v;
      }
      window.localStorage.setItem(key, JSON.stringify(trimmedMap));
      return;
    }

    window.localStorage.setItem(key, JSON.stringify(existing));
  } catch {
    // Storage can fail in private browsing / quota-exceeded cases. Silently
    // drop; in-memory state still works for the current session.
  }
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
