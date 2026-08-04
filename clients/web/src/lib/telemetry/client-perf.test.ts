/**
 * Pins the shared `client_*` perf emitter's wire contract:
 *   - One watchdog-shaped event carrying the page-load grouping key, surface,
 *     os, and a rounded value, with caller detail merged last.
 *   - Nothing is emitted without analytics consent.
 *   - `boot_id` appears only once a boot id has been registered.
 *   - A throwing transport never propagates to the caller.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let consent = true;
const postTelemetryEventsMock = mock((_events: readonly object[]) => {});

mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => consent,
}));
mock.module("@/lib/telemetry/ingest", () => ({
  postTelemetryEvents: postTelemetryEventsMock,
}));

const { __resetClientPerfForTests, emitClientPerfEvent, setClientPerfBootId } =
  await import("./client-perf");

function lastEvent(): Record<string, unknown> {
  const call = postTelemetryEventsMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  const events = call![0];
  expect(events).toHaveLength(1);
  return events[0] as Record<string, unknown>;
}

function lastDetail(): Record<string, unknown> {
  return lastEvent().detail as Record<string, unknown>;
}

beforeEach(() => {
  consent = true;
  postTelemetryEventsMock.mockClear();
  postTelemetryEventsMock.mockImplementation(() => {});
  __resetClientPerfForTests();
});

describe("emitClientPerfEvent", () => {
  test("emits one watchdog-shaped event with the perf detail bag", () => {
    emitClientPerfEvent("client_switch.transcript_painted", 412.7);

    const event = lastEvent();
    expect(event.type).toBe("watchdog");
    expect(event.check_name).toBe("client_switch.transcript_painted");
    expect(event.value).toBe(413);
    expect(typeof event.daemon_event_id).toBe("string");
    expect(typeof event.recorded_at).toBe("number");

    const detail = lastDetail();
    expect(typeof detail.page_load_id).toBe("string");
    expect(["ios_native", "android_native", "web"]).toContain(
      String(detail.surface),
    );
    expect(typeof detail.os).toBe("string");
  });

  test("groups events from the same page load under one page_load_id", () => {
    emitClientPerfEvent("client_list.drain", 1);
    const first = lastDetail().page_load_id;
    emitClientPerfEvent("client_list.drain", 2);
    expect(lastDetail().page_load_id).toBe(first);
  });

  test("merges caller detail last so its keys win", () => {
    emitClientPerfEvent("client_resume.request_count", 3, {
      reason: "visibility",
      surface: "caller_override",
    });

    const detail = lastDetail();
    expect(detail.reason).toBe("visibility");
    expect(detail.surface).toBe("caller_override");
  });

  test("emits nothing without analytics consent", () => {
    consent = false;
    emitClientPerfEvent("client_switch.stalled", 5000);
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();
  });

  test("omits boot_id until one is registered", () => {
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail()).not.toHaveProperty("boot_id");

    setClientPerfBootId("boot-123");
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail().boot_id).toBe("boot-123");
  });

  test("swallows a throwing transport", () => {
    postTelemetryEventsMock.mockImplementation(() => {
      throw new Error("transport down");
    });
    expect(() => {
      emitClientPerfEvent("client_switch.stalled", 1);
    }).not.toThrow();
  });
});
