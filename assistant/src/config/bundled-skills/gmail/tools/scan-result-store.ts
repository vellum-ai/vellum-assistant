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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSenderData(value: unknown): value is SenderData {
  if (!isRecord(value)) return false;
  const messageIds = value.messageIds;
  return (
    Array.isArray(messageIds) &&
    messageIds.every((id) => typeof id === "string") &&
    typeof value.newestMessageId === "string" &&
    (typeof value.newestUnsubscribableMessageId === "string" ||
      value.newestUnsubscribableMessageId === null)
  );
}

function parseScanPayload(
  data: unknown,
): { senders: Record<string, unknown> } | null {
  if (!isRecord(data)) return null;
  const senders = data.senders;
  if (!isRecord(senders)) return null;
  return { senders };
}

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

  // Keep bookkeeping bounded without mutating shared cache contents.
  if (_trackedScanIds.size > MAX_TRACKED_SCAN_IDS) {
    const oldest = _trackedScanIds.values().next().value;
    if (oldest !== undefined) {
      _trackedScanIds.delete(oldest);
    }
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

  const payload = parseScanPayload(result.data);
  if (!payload) return null;
  const ids: string[] = [];
  for (const sid of senderIds) {
    const data = payload.senders[sid];
    if (isSenderData(data)) ids.push(...data.messageIds);
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

  const payload = parseScanPayload(result.data);
  if (!payload) return null;
  const data = payload.senders[senderId];
  if (!isSenderData(data)) return null;
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
