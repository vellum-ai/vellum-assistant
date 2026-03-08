import { beforeEach, describe, expect, it } from "bun:test";

import {
  _internals,
  clearScanStore,
  getSenderMessageIds,
  getSenderMetadata,
  storeScanResult,
} from "../skills/bundled-skills/messaging/tools/scan-result-store.js";

describe("scan-result-store", () => {
  beforeEach(() => {
    clearScanStore();
  });

  const makeSenders = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `sender-${i}`,
      messageIds: [`msg-${i}-a`, `msg-${i}-b`],
      newestMessageId: `msg-${i}-a`,
      newestUnsubscribableMessageId: i % 2 === 0 ? `msg-${i}-a` : null,
    }));

  it("stores and retrieves message IDs", () => {
    const senders = makeSenders(3);
    const scanId = storeScanResult(senders);

    const ids = getSenderMessageIds(scanId, ["sender-0", "sender-2"]);
    expect(ids).toEqual(["msg-0-a", "msg-0-b", "msg-2-a", "msg-2-b"]);
  });

  it("returns null for unknown scan ID", () => {
    expect(getSenderMessageIds("nonexistent", ["sender-0"])).toBeNull();
  });

  it("returns empty array for unknown sender IDs", () => {
    const scanId = storeScanResult(makeSenders(1));
    const ids = getSenderMessageIds(scanId, ["unknown-sender"]);
    expect(ids).toEqual([]);
  });

  it("retrieves sender metadata", () => {
    const senders = makeSenders(2);
    const scanId = storeScanResult(senders);

    const meta0 = getSenderMetadata(scanId, "sender-0");
    expect(meta0).toEqual({
      newestMessageId: "msg-0-a",
      newestUnsubscribableMessageId: "msg-0-a",
    });

    const meta1 = getSenderMetadata(scanId, "sender-1");
    expect(meta1).toEqual({
      newestMessageId: "msg-1-a",
      newestUnsubscribableMessageId: null,
    });
  });

  it("returns null metadata for unknown sender", () => {
    const scanId = storeScanResult(makeSenders(1));
    expect(getSenderMetadata(scanId, "unknown")).toBeNull();
  });

  it("evicts oldest entry when at capacity (LRU)", () => {
    const scanIds: string[] = [];
    for (let i = 0; i < 16; i++) {
      scanIds.push(
        storeScanResult([
          {
            id: `s-${i}`,
            messageIds: [`m-${i}`],
            newestMessageId: `m-${i}`,
            newestUnsubscribableMessageId: null,
          },
        ]),
      );
    }

    // All 16 should be present
    expect(getSenderMessageIds(scanIds[0], ["s-0"])).toEqual(["m-0"]);

    // Adding a 17th should evict the oldest (scanIds[0] was accessed last via getSenderMessageIds, so scanIds[1] is oldest)
    const newId = storeScanResult([
      {
        id: "s-new",
        messageIds: ["m-new"],
        newestMessageId: "m-new",
        newestUnsubscribableMessageId: null,
      },
    ]);

    // scanIds[1] should be evicted (it was the LRU after we accessed scanIds[0])
    expect(getSenderMessageIds(scanIds[1], ["s-1"])).toBeNull();
    // The new entry and scanIds[0] should still be present
    expect(getSenderMessageIds(newId, ["s-new"])).toEqual(["m-new"]);
    expect(getSenderMessageIds(scanIds[0], ["s-0"])).toEqual(["m-0"]);
  });

  it("expires entries after TTL", () => {
    const scanId = storeScanResult(makeSenders(1));

    // Manually age the entry beyond TTL
    const entry = _internals.store.get(scanId);
    expect(entry).toBeDefined();
    entry!.createdAt = Date.now() - _internals.TTL_MS - 1;

    expect(getSenderMessageIds(scanId, ["sender-0"])).toBeNull();
    // Entry should be cleaned up
    expect(_internals.store.has(scanId)).toBe(false);
  });

  it("expires entries in getSenderMetadata after TTL", () => {
    const scanId = storeScanResult(makeSenders(1));

    const entry = _internals.store.get(scanId);
    entry!.createdAt = Date.now() - _internals.TTL_MS - 1;

    expect(getSenderMetadata(scanId, "sender-0")).toBeNull();
    expect(_internals.store.has(scanId)).toBe(false);
  });
});
