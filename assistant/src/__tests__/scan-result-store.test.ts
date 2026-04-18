import { afterEach, describe, expect, test } from "bun:test";

import {
  _internals,
  clearScanStore,
  getSenderMessageIds,
  getSenderMetadata,
  storeScanResult,
} from "../config/bundled-skills/gmail/tools/scan-result-store.js";
import { clearCacheForTests } from "../skills/skill-cache-store.js";

afterEach(() => {
  clearScanStore();
  clearCacheForTests();
});

describe("storeScanResult / getSenderMessageIds round-trip", () => {
  test("stores senders and retrieves flattened message IDs", () => {
    const scanId = storeScanResult([
      {
        id: "sender-a",
        messageIds: ["m1", "m2"],
        newestMessageId: "m2",
        newestUnsubscribableMessageId: null,
      },
      {
        id: "sender-b",
        messageIds: ["m3"],
        newestMessageId: "m3",
        newestUnsubscribableMessageId: "m3",
      },
    ]);

    const ids = getSenderMessageIds(scanId, ["sender-a", "sender-b"]);
    expect(ids).not.toBeNull();
    expect(ids).toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    expect(ids).toHaveLength(3);
  });

  test("returns only requested senders' message IDs", () => {
    const scanId = storeScanResult([
      {
        id: "sender-a",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
      {
        id: "sender-b",
        messageIds: ["m2"],
        newestMessageId: "m2",
        newestUnsubscribableMessageId: null,
      },
    ]);

    const ids = getSenderMessageIds(scanId, ["sender-a"]);
    expect(ids).toEqual(["m1"]);
  });

  test("returns empty array when sender IDs do not match", () => {
    const scanId = storeScanResult([
      {
        id: "sender-a",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
    ]);

    const ids = getSenderMessageIds(scanId, ["nonexistent"]);
    expect(ids).toEqual([]);
  });
});

describe("missing scan ID returns null", () => {
  test("getSenderMessageIds returns null for unknown scan ID", () => {
    expect(getSenderMessageIds("no-such-scan", ["s1"])).toBeNull();
  });

  test("getSenderMetadata returns null for unknown scan ID", () => {
    expect(getSenderMetadata("no-such-scan", "s1")).toBeNull();
  });
});

describe("getSenderMetadata", () => {
  test("returns metadata for a known sender", () => {
    const scanId = storeScanResult([
      {
        id: "sender-x",
        messageIds: ["m1", "m2"],
        newestMessageId: "m2",
        newestUnsubscribableMessageId: "m1",
      },
    ]);

    const meta = getSenderMetadata(scanId, "sender-x");
    expect(meta).toEqual({
      newestMessageId: "m2",
      newestUnsubscribableMessageId: "m1",
    });
  });

  test("returns null for unknown sender within a valid scan", () => {
    const scanId = storeScanResult([
      {
        id: "sender-x",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
    ]);

    expect(getSenderMetadata(scanId, "sender-unknown")).toBeNull();
  });

  test("returns null newestUnsubscribableMessageId when not present", () => {
    const scanId = storeScanResult([
      {
        id: "sender-y",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
    ]);

    const meta = getSenderMetadata(scanId, "sender-y");
    expect(meta).toEqual({
      newestMessageId: "m1",
      newestUnsubscribableMessageId: null,
    });
  });
});

describe("clearScanStore", () => {
  test("clears all tracked scan entries from the shared cache", () => {
    const scanId1 = storeScanResult([
      {
        id: "s1",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
    ]);
    const scanId2 = storeScanResult([
      {
        id: "s2",
        messageIds: ["m2"],
        newestMessageId: "m2",
        newestUnsubscribableMessageId: null,
      },
    ]);

    // Sanity: both are retrievable
    expect(getSenderMessageIds(scanId1, ["s1"])).not.toBeNull();
    expect(getSenderMessageIds(scanId2, ["s2"])).not.toBeNull();

    clearScanStore();

    // After clear, both should be gone
    expect(getSenderMessageIds(scanId1, ["s1"])).toBeNull();
    expect(getSenderMessageIds(scanId2, ["s2"])).toBeNull();
  });

  test("clears tracked scan IDs set", () => {
    storeScanResult([
      {
        id: "s1",
        messageIds: ["m1"],
        newestMessageId: "m1",
        newestUnsubscribableMessageId: null,
      },
    ]);

    expect(_internals.trackedScanIds.size).toBe(1);
    clearScanStore();
    expect(_internals.trackedScanIds.size).toBe(0);
  });
});

describe("_internals", () => {
  test("TTL_MS is 30 minutes", () => {
    expect(_internals.TTL_MS).toBe(30 * 60_000);
  });
});
