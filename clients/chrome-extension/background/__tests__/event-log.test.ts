import { describe, test, expect, beforeEach } from "bun:test";
import { appendEvent, getEventLog, clearEventLog } from "../event-log.js";

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
