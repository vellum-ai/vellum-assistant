import {
  deleteCacheEntry,
  getCacheEntry,
  setCacheEntry,
} from "../../../../skills/skill-cache-store.js";

interface SenderData {
  messageIds: string[];
  newestMessageId: string;
  newestUnsubscribableMessageId: string | null;
}

/**
 * Serializable payload stored in the shared cache.
 * Uses a plain object (not a Map) so it round-trips through the cache cleanly.
 */
interface ScanPayload {
  senders: Record<string, SenderData>;
}

const TTL_MS = 30 * 60_000; // 30 minutes

/**
 * Maximum number of scan IDs to track. Matches the shared cache capacity
 * so bookkeeping never grows beyond what the cache itself can hold.
 */
const MAX_TRACKED_SCAN_IDS = 64;

/**
 * Local bookkeeping of scan IDs produced by this module so
 * `clearScanStore()` can delete them from the shared cache.
 *
 * Bounded to `MAX_TRACKED_SCAN_IDS` — when full, the oldest entry
 * (first in Set iteration order) is evicted.
 */
const _trackedScanIds = new Set<string>();

/** Store scan results and return a unique scan ID. */
export function storeScanResult(
  senders: Array<{
    id: string;
    messageIds: string[];
    newestMessageId: string;
    newestUnsubscribableMessageId: string | null;
  }>,
): string {
  const sendersObj: Record<string, SenderData> = {};
  for (const s of senders) {
    sendersObj[s.id] = {
      messageIds: s.messageIds,
      newestMessageId: s.newestMessageId,
      newestUnsubscribableMessageId: s.newestUnsubscribableMessageId,
    };
  }

  const payload: ScanPayload = { senders: sendersObj };
  const { key: scanId } = setCacheEntry(payload, { ttlMs: TTL_MS });
  _trackedScanIds.add(scanId);

  // Evict the oldest tracked ID when over capacity (Set preserves insertion order).
  if (_trackedScanIds.size > MAX_TRACKED_SCAN_IDS) {
    const oldest = _trackedScanIds.values().next().value;
    if (oldest !== undefined) _trackedScanIds.delete(oldest);
  }

  return scanId;
}

/** Retrieve message IDs for the given senders from a scan result. */
export function getSenderMessageIds(
  scanId: string,
  senderIds: string[],
): string[] | null {
  const result = getCacheEntry(scanId);
  if (!result) return null;

  const payload = result.data as ScanPayload;
  const ids: string[] = [];
  for (const sid of senderIds) {
    const data = payload.senders[sid];
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
  const result = getCacheEntry(scanId);
  if (!result) return null;

  const payload = result.data as ScanPayload;
  const data = payload.senders[senderId];
  if (!data) return null;
  return {
    newestMessageId: data.newestMessageId,
    newestUnsubscribableMessageId: data.newestUnsubscribableMessageId,
  };
}

/** Clear the store (for tests). */
export function clearScanStore(): void {
  for (const scanId of _trackedScanIds) {
    deleteCacheEntry(scanId);
  }
  _trackedScanIds.clear();
}

/** Visible for testing. */
export const _internals = {
  TTL_MS,
  MAX_TRACKED_SCAN_IDS,
  trackedScanIds: _trackedScanIds,
};
