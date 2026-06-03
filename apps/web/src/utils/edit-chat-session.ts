/**
 * Per-app "edit conversation" memory.
 *
 * When the user clicks Edit on an opened app we want subsequent edit clicks
 * (same app, same browser session) to drop them back into the same chat — so
 * the assistant can iterate on the app without losing thread. After a TTL
 * elapses or the tab is closed, the next Edit click mints a fresh chat.
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

function readEntry(key: string): Entry | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Entry;
    if (typeof parsed.conversationId !== "string" || typeof parsed.lastUsedAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeEntry(key: string, entry: Entry): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // sessionStorage may throw on quota / locked state — swallow silently
  }
}

export function getEditChatConversationId(
  assistantId: string,
  appId: string,
  now: number = Date.now(),
): string | null {
  const key = buildKey(assistantId, appId);
  const entry = readEntry(key);
  if (!entry) return null;
  if (now - entry.lastUsedAt > TTL_MS) {
    const store = storage();
    store?.removeItem(key);
    return null;
  }
  return entry.conversationId;
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
 * When a draft conversation id is resolved to a real server-assigned id
 * (first message sent), update any stored edit-chat entries that referenced
 * the draft. Without this, the next Edit click would land on a conversation
 * id that no longer exists.
 */
export function resolveEditChatDraftConversationId(oldConversationId: string, newConversationId: string): void {
  const store = storage();
  if (!store) return;
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const entry = readEntry(key);
    if (!entry || entry.conversationId !== oldConversationId) continue;
    writeEntry(key, { ...entry, conversationId: newConversationId });
  }
}

export const __TEST_ONLY__ = { PREFIX, TTL_MS };
