import { describe, test, expect, beforeEach } from "bun:test";
import {
  appendEvent,
  getEventLog,
  clearEventLog,
  recordRequest,
  recordResponse,
  getOperations,
  getOperationById,
} from "../event-log.js";

describe("event-log", () => {
  beforeEach(() => {
    clearEventLog();
  });

  test("starts empty", () => {
    expect(getEventLog()).toEqual([]);
  });

  test("appends entries with auto-incrementing IDs", () => {
    appendEvent("inbound", "host_browser_request", {
      summary: "Page.navigate (abc12345)",
    });
    appendEvent("outbound", "host_browser_result", {
      summary: "abc12345",
      isError: false,
    });

    const log = getEventLog();
    expect(log.length).toBe(2);
    expect(log[0]!.id).toBe(1);
    expect(log[0]!.direction).toBe("inbound");
    expect(log[0]!.eventType).toBe("host_browser_request");
    expect(log[0]!.summary).toBe("Page.navigate (abc12345)");
    expect(log[1]!.id).toBe(2);
    expect(log[1]!.direction).toBe("outbound");
    expect(log[1]!.isError).toBe(false);
  });

  test("caps at 100 entries", () => {
    for (let i = 0; i < 120; i++) {
      appendEvent("inbound", "test", { summary: `event-${i}` });
    }
    const log = getEventLog();
    expect(log.length).toBe(100);
    // Oldest entries were dropped — first entry should be event-20
    expect(log[0]!.summary).toBe("event-20");
    expect(log[99]!.summary).toBe("event-119");
  });

  test("returns a snapshot (not a reference)", () => {
    appendEvent("inbound", "test");
    const snap1 = getEventLog();
    appendEvent("outbound", "test2");
    const snap2 = getEventLog();
    expect(snap1.length).toBe(1);
    expect(snap2.length).toBe(2);
  });

  test("clearEventLog resets buffer and IDs", () => {
    appendEvent("inbound", "test");
    clearEventLog();
    expect(getEventLog()).toEqual([]);
    const entry = appendEvent("inbound", "test");
    expect(entry.id).toBe(1);
  });

  test("entries have ISO timestamps", () => {
    const entry = appendEvent("inbound", "test");
    expect(entry.timestamp.startsWith("20")).toBe(true);
    expect(entry.timestamp.includes("T")).toBe(true);
  });

  test("isError defaults to undefined", () => {
    const entry = appendEvent("inbound", "test");
    expect(entry.isError).toBeUndefined();
  });
});

describe("operations", () => {
  beforeEach(() => {
    clearEventLog();
  });

  test("starts empty", () => {
    expect(getOperations()).toEqual([]);
  });

  test("recordRequest creates an operation", () => {
    const op = recordRequest("req-1", "Page.navigate", {
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://example.com" },
    });
    expect(op.id).toBe(1);
    expect(op.requestId).toBe("req-1");
    expect(op.operationName).toBe("Page.navigate");
    expect(op.request).toEqual({
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://example.com" },
    });
    expect(op.respondedAt).toBeUndefined();
    expect(op.durationMs).toBeUndefined();
  });

  test("recordResponse correlates with existing request", () => {
    recordRequest("req-1", "Page.navigate");
    recordResponse("req-1", {
      isError: false,
      responseContent: '{"frameId":"abc"}',
    });

    const ops = getOperations();
    expect(ops.length).toBe(1);
    expect(ops[0]!.respondedAt).toBeDefined();
    expect(ops[0]!.isError).toBe(false);
    expect(ops[0]!.responseContent).toBe('{"frameId":"abc"}');
    expect(ops[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("recordResponse for unknown requestId is a no-op", () => {
    recordResponse("nonexistent", { isError: false });
    expect(getOperations()).toEqual([]);
  });

  test("caps at 50 operations", () => {
    for (let i = 0; i < 60; i++) {
      recordRequest(`req-${i}`, `Method.${i}`);
    }
    const ops = getOperations();
    expect(ops.length).toBe(50);
    expect(ops[0]!.requestId).toBe("req-10");
    expect(ops[49]!.requestId).toBe("req-59");
  });

  test("getOperationById returns the right operation", () => {
    const op1 = recordRequest("req-1", "Page.navigate");
    recordRequest("req-2", "Runtime.evaluate");

    expect(getOperationById(op1.id)?.operationName).toBe("Page.navigate");
    expect(getOperationById(999)).toBeUndefined();
  });

  test("clearEventLog also clears operations", () => {
    recordRequest("req-1", "Page.navigate");
    clearEventLog();
    expect(getOperations()).toEqual([]);
    const op = recordRequest("req-2", "Runtime.evaluate");
    expect(op.id).toBe(1);
  });

  test("operations snapshot is independent of buffer", () => {
    recordRequest("req-1", "Page.navigate");
    const snap1 = getOperations();
    recordRequest("req-2", "Runtime.evaluate");
    const snap2 = getOperations();
    expect(snap1.length).toBe(1);
    expect(snap2.length).toBe(2);
  });

  test("error response is tracked", () => {
    recordRequest("req-1", "Page.navigate");
    recordResponse("req-1", {
      isError: true,
      responseContent: "Target closed",
    });

    const ops = getOperations();
    expect(ops[0]!.isError).toBe(true);
    expect(ops[0]!.responseContent).toBe("Target closed");
  });
});
