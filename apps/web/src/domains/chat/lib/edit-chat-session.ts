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
  conversationKey: string;
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
    if (typeof parsed.conversationKey !== "string" || typeof parsed.lastUsedAt !== "number") {
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

export function getEditChatKey(
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
  return entry.conversationKey;
}

export function setEditChatKey(
  assistantId: string,
  appId: string,
  conversationKey: string,
  now: number = Date.now(),
): void {
  writeEntry(buildKey(assistantId, appId), { conversationKey, lastUsedAt: now });
}

/**
 * When a draft conversation key is resolved to a real server-assigned key
 * (first message sent), update any stored edit-chat entries that referenced
 * the draft. Without this, the next Edit click would land on a conversation
 * key that no longer exists.
 */
export function resolveEditChatDraftKey(oldKey: string, newKey: string): void {
  const store = storage();
  if (!store) return;
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const entry = readEntry(key);
    if (!entry || entry.conversationKey !== oldKey) continue;
    writeEntry(key, { ...entry, conversationKey: newKey });
  }
}

export const __TEST_ONLY__ = { PREFIX, TTL_MS };
