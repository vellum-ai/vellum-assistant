/**
 * Per-app "edit conversation" memory.
 *
 * When the user clicks Edit on an opened app we want subsequent edit clicks
 * (same app, same browser session) to drop them back into the same chat, so
 * the assistant can iterate on the app without losing thread. An app entry
 * ages out once a TTL elapses, and the next Edit click past that mints a
 * fresh chat, as does the first click in a new tab.
 *
 * The same store holds each client draft conversation id the daemon replaced
 * with a row of its own, keyed by the retired draft, so a surface still open
 * against that draft can reach the row that replaced it. Draft replacements
 * carry no TTL: the id they replace can never be sent against again, so the
 * mapping stays valid for the life of the tab.
 *
 * Storage: sessionStorage (per-tab). Each app has its own entry; entries are
 * never shared across apps or assistants.
 */

const PREFIX = "vellum:edit-chat:";
const TTL_MS = 4 * 60 * 60 * 1000;

interface Entry {
  conversationId: string;
  lastUsedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function buildKey(assistantId: string, appId: string): string {
  return `${PREFIX}${assistantId}:${appId}`;
}

function buildDraftKey(
  assistantId: string,
  draftConversationId: string,
): string {
  return `${PREFIX}draft:${assistantId}:${draftConversationId}`;
}

function readEntry(key: string): Entry | null {
  const store = storage();
  if (!store) {
    return null;
  }
  const raw = store.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Entry;
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.lastUsedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeEntry(key: string, entry: Entry): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // sessionStorage may throw on quota / locked state — swallow silently
  }
}

function readLiveConversationId(key: string, now: number): string | null {
  const entry = readEntry(key);
  if (!entry) {
    return null;
  }
  if (now - entry.lastUsedAt > TTL_MS) {
    const store = storage();
    store?.removeItem(key);
    return null;
  }
  return entry.conversationId;
}

export function getEditChatConversationId(
  assistantId: string,
  appId: string,
  now: number = Date.now(),
): string | null {
  return readLiveConversationId(buildKey(assistantId, appId), now);
}

export function setEditChatConversationId(
  assistantId: string,
  appId: string,
  conversationId: string,
  now: number = Date.now(),
): void {
  writeEntry(buildKey(assistantId, appId), { conversationId, lastUsedAt: now });
}

/**
 * Record the row a client draft conversation id resolved to, so a surface
 * holding the retired draft can find it. The entry outlives the app-entry
 * TTL and reads back through {@link getEditChatDraftReplacement}.
 */
export function setEditChatDraftReplacement(
  assistantId: string,
  draftConversationId: string,
  conversationId: string,
  now: number = Date.now(),
): void {
  writeEntry(buildDraftKey(assistantId, draftConversationId), {
    conversationId,
    lastUsedAt: now,
  });
}

/**
 * The row that replaced a client draft conversation id in this tab, or `null`
 * when the draft was never replaced. The mapping does not expire: the draft id
 * it replaces can never be sent against again, so the row it names stays the
 * only handle a surface holding that draft has.
 */
export function getEditChatDraftReplacement(
  assistantId: string,
  draftConversationId: string,
): string | null {
  return (
    readEntry(buildDraftKey(assistantId, draftConversationId))
      ?.conversationId ?? null
  );
}

/**
 * When a draft conversation id is resolved to a real server-assigned id
 * (first message sent), record the replacement and update any stored
 * edit-chat entries that referenced the draft. Without this, the next Edit
 * click would land on a conversation id that no longer exists, and a surface
 * still open against the draft would send against an id the daemon has never
 * minted.
 */
export function resolveEditChatDraftConversationId(
  assistantId: string,
  oldConversationId: string,
  newConversationId: string,
): void {
  const store = storage();
  if (!store) {
    return;
  }
  if (oldConversationId !== newConversationId) {
    setEditChatDraftReplacement(
      assistantId,
      oldConversationId,
      newConversationId,
    );
  }
  const assistantPrefix = `${PREFIX}${assistantId}:`;
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key || !key.startsWith(assistantPrefix)) {
      continue;
    }
    const entry = readEntry(key);
    if (!entry || entry.conversationId !== oldConversationId) {
      continue;
    }
    writeEntry(key, { ...entry, conversationId: newConversationId });
  }
}

export const __TEST_ONLY__ = { PREFIX, TTL_MS };
