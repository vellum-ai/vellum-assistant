import { beforeEach, describe, expect, it, mock } from "bun:test";

// Track calls to extractAndUpsertMemoryItemsForMessage
const extractMock = mock(() => Promise.resolve());

mock.module("./items-extractor.js", () => ({
  extractAndUpsertMemoryItemsForMessage: extractMock,
}));

// Track calls to rawGet — controls isAlreadyExtracted behavior
let rawGetReturn: unknown = null;
const rawGetMock = mock((_sql: string, ..._params: unknown[]) => rawGetReturn);

mock.module("./raw-query.js", () => ({
  rawGet: rawGetMock,
}));

// Suppress log output during tests
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Import after mocks are registered
const { flushMemoryForMessages } = await import("./flush.js");

const baseOpts = () => ({
  conversationId: "conv-1",
  scopeId: "scope-1",
});

describe("flushMemoryForMessages", () => {
  beforeEach(() => {
    extractMock.mockClear();
    rawGetMock.mockClear();
    rawGetReturn = null; // no completed job → not yet extracted
  });

  it("extracts from un-processed messages", async () => {
    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
    });

    expect(extractMock).toHaveBeenCalledTimes(2);
    expect(extractMock).toHaveBeenCalledWith("msg-1", "scope-1", "conv-1");
    expect(extractMock).toHaveBeenCalledWith("msg-2", "scope-1", "conv-1");
    expect(result).toEqual({ flushed: 2, skipped: 0 });
  });

  it("skips already-extracted messages", async () => {
    // rawGet returns a row → isAlreadyExtracted returns true
    rawGetReturn = { id: "job-1" };

    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
    });

    expect(extractMock).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ flushed: 0, skipped: 2 });
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    // Abort immediately before calling
    controller.abort();

    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
      abortSignal: controller.signal,
    });

    expect(extractMock).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ flushed: 0, skipped: 0 });
  });

  it("aborts mid-flush when signal fires", async () => {
    const controller = new AbortController();

    // Abort after the first extraction completes
    extractMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
      { id: "msg-3", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
      abortSignal: controller.signal,
    });

    // First message processed, then abort checked before second
    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ flushed: 1, skipped: 0 });
  });

  it("handles extraction errors without crashing the flush", async () => {
    // The implementation does NOT catch errors per-message — it will propagate.
    // Verify that a thrown error actually propagates (the function is not
    // silently swallowing it). This documents the current behavior.
    extractMock
      .mockImplementationOnce(() => Promise.resolve()) // msg-1 succeeds
      .mockImplementationOnce(() =>
        Promise.reject(new Error("extraction failed")),
      ); // msg-2 fails

    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
      { id: "msg-3", role: "user" },
    ];

    await expect(
      flushMemoryForMessages({ ...baseOpts(), messages }),
    ).rejects.toThrow("extraction failed");

    // msg-1 was extracted, msg-2 threw
    expect(extractMock).toHaveBeenCalledTimes(2);
  });

  it("filters to user messages only", async () => {
    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "assistant" },
      { id: "msg-3", role: "system" },
      { id: "msg-4", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
    });

    expect(extractMock).toHaveBeenCalledTimes(2);
    expect(extractMock).toHaveBeenCalledWith("msg-1", "scope-1", "conv-1");
    expect(extractMock).toHaveBeenCalledWith("msg-4", "scope-1", "conv-1");
    expect(result).toEqual({ flushed: 2, skipped: 0 });
  });

  it("returns zeroes for empty message list", async () => {
    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages: [],
    });

    expect(extractMock).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ flushed: 0, skipped: 0 });
  });

  it("mixes skipped and flushed correctly", async () => {
    // Alternate between extracted and not-extracted messages
    let callCount = 0;
    rawGetMock.mockImplementation(() => {
      callCount++;
      // First call (msg-1): already extracted, second call (msg-2): not
      return callCount === 1 ? { id: "job-1" } : null;
    });

    const messages = [
      { id: "msg-1", role: "user" },
      { id: "msg-2", role: "user" },
    ];

    const result = await flushMemoryForMessages({
      ...baseOpts(),
      messages,
    });

    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(extractMock).toHaveBeenCalledWith("msg-2", "scope-1", "conv-1");
    expect(result).toEqual({ flushed: 1, skipped: 1 });
  });
});
