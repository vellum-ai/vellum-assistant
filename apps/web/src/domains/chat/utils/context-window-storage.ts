export interface ContextWindowUsage {
  tokens: number;
  maxTokens: number | null;
  fillRatio: number | null;
}

// Persist per-conversation context window usage to localStorage so the indicator
// survives page reloads. The desktop client keeps this state alive via a
// long-lived per-conversation ChatViewModel; the web client is a short-lived
// browser tab, so we mirror the semantics with localStorage instead.
//
// Shape on disk: { [conversationId]: ContextWindowUsage }, keyed per assistant.

const STORAGE_KEY_PREFIX = "vellum:ctxwindow:";
// Cap per-assistant entries to keep localStorage footprint bounded. Older
// entries are dropped oldest-first when we exceed the limit.
const MAX_ENTRIES_PER_ASSISTANT = 200;

type StoredMap = Record<string, ContextWindowUsage>;

function storageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

function isValidUsage(value: unknown): value is ContextWindowUsage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tokens !== "number" || !Number.isFinite(record.tokens)) {
    return false;
  }
  if (
    record.maxTokens !== null &&
    (typeof record.maxTokens !== "number" || !Number.isFinite(record.maxTokens))
  ) {
    return false;
  }
  if (
    record.fillRatio !== null &&
    (typeof record.fillRatio !== "number" || !Number.isFinite(record.fillRatio))
  ) {
    return false;
  }
  return true;
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
      if (isValidUsage(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function loadContextWindowUsageMap(assistantId: string): Map<string, ContextWindowUsage> {
  if (typeof window === "undefined") {
    return new Map();
  }
  try {
    const raw = window.localStorage.getItem(storageKey(assistantId));
    return new Map(Object.entries(safeParse(raw)));
  } catch {
    return new Map();
  }
}

export function saveContextWindowUsage(
  assistantId: string,
  conversationId: string,
  usage: ContextWindowUsage,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = storageKey(assistantId);
    const existing = safeParse(window.localStorage.getItem(key));
    existing[conversationId] = usage;

    const entries = Object.entries(existing);
    if (entries.length > MAX_ENTRIES_PER_ASSISTANT) {
      // Drop oldest entries. We don't track timestamps, so this relies on
      // insertion order being preserved by JSON serialization, which holds
      // for all supported browsers.
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
    // drop; the in-memory cache still works for the current session.
  }
}
