// Persist per-conversation context window usage to localStorage so the indicator
// survives page reloads. The desktop client keeps this state alive via a
// long-lived per-conversation ChatViewModel; the web client is a short-lived
// browser tab, so we mirror the semantics with localStorage instead.

import { createRecordStorageAccessor } from "@/utils/typed-storage";

export interface ContextWindowUsage {
  tokens: number;
  maxTokens: number | null;
  fillRatio: number | null;
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

const storage = createRecordStorageAccessor<ContextWindowUsage>({
  keyFn: (assistantId) => `vellum:ctxwindow:${assistantId}`,
  scope: "user",
  parseValue: (value) => (isValidUsage(value) ? value : null),
  fallback: {},
  maxEntries: 200,
});

export function loadContextWindowUsageMap(
  assistantId: string,
): Map<string, ContextWindowUsage> {
  return new Map(Object.entries(storage.load(assistantId)));
}

export function saveContextWindowUsage(
  assistantId: string,
  conversationId: string,
  usage: ContextWindowUsage,
): void {
  storage.set(assistantId, conversationId, usage);
}
