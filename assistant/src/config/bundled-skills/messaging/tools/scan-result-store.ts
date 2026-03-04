import { randomBytes } from "crypto";

interface SenderData {
  messageIds: string[];
  newestMessageId: string;
  newestUnsubscribableMessageId: string | null;
}

interface ScanEntry {
  senders: Map<string, SenderData>;
  createdAt: number;
}

const MAX_ENTRIES = 16;
const TTL_MS = 30 * 60_000; // 30 minutes

const _store = new Map<string, ScanEntry>();

/** Store scan results and return a unique scan ID. */
export function storeScanResult(
  senders: Array<{
    id: string;
    messageIds: string[];
    newestMessageId: string;
    newestUnsubscribableMessageId: string | null;
  }>,
): string {
  const scanId = randomBytes(8).toString("hex");

  // LRU eviction: remove oldest if at capacity
  if (_store.size >= MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    if (oldest !== undefined) _store.delete(oldest);
  }

  const senderMap = new Map<string, SenderData>();
  for (const s of senders) {
    senderMap.set(s.id, {
      messageIds: s.messageIds,
      newestMessageId: s.newestMessageId,
      newestUnsubscribableMessageId: s.newestUnsubscribableMessageId,
    });
  }

  _store.set(scanId, { senders: senderMap, createdAt: Date.now() });
  return scanId;
}

/** Retrieve message IDs for the given senders from a scan result. */
export function getSenderMessageIds(
  scanId: string,
  senderIds: string[],
): string[] | null {
  const entry = _store.get(scanId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    _store.delete(scanId);
    return null;
  }
  // LRU: move to end
  _store.delete(scanId);
  _store.set(scanId, entry);

  const ids: string[] = [];
  for (const sid of senderIds) {
    const data = entry.senders.get(sid);
    if (data) ids.push(...data.messageIds);
  }
  return ids;
}

/** Retrieve metadata for a single sender from a scan result. */
export function getSenderMetadata(
  scanId: string,
  senderId: string,
): {
  newestMessageId: string;
  newestUnsubscribableMessageId: string | null;
} | null {
  const entry = _store.get(scanId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    _store.delete(scanId);
    return null;
  }
  const data = entry.senders.get(senderId);
  if (!data) return null;
  return {
    newestMessageId: data.newestMessageId,
    newestUnsubscribableMessageId: data.newestUnsubscribableMessageId,
  };
}

/** Clear the store (for tests). */
export function clearScanStore(): void {
  _store.clear();
}

/** Visible for testing: override TTL check by returning internal store reference. */
export const _internals = { store: _store, TTL_MS };
