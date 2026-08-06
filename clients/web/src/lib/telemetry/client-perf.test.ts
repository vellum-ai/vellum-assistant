/**
 * Pins the shared `client_*` perf emitter's wire contract:
 *   - One watchdog-shaped event carrying the page-load grouping key, surface,
 *     os, and a rounded value, with caller detail merged last.
 *   - Nothing is emitted without analytics consent.
 *   - `boot_id` appears only once a boot id has been registered.
 *   - A throwing transport never propagates to the caller.
 *   - The page-load key is minted lazily, and it and the event id both survive
 *     a runtime with no `crypto.randomUUID` (non-secure contexts).
 *   - Surface and os come from a single platform probe per emit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ClientPerfCheckName } from "./client-perf";

let consent = true;
let nativeIOS = false;
let nativeAndroid = false;
const postTelemetryEventsMock = mock((_events: readonly object[]) => {});
const detectClientOsMock = mock(() => "web");

mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => consent,
}));
mock.module("@/lib/telemetry/ingest", () => ({
  postTelemetryEvents: postTelemetryEventsMock,
}));
mock.module("@/runtime/platform-detection", () => ({
  detectClientOs: detectClientOsMock,
  isNativeIOS: () => nativeIOS,
  isNativeAndroid: () => nativeAndroid,
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

/**
 * Every member of the exported union. `satisfies` rejects an entry that is not
 * a check name, and the `AssertNever` alias below rejects a check name that is
 * missing from the tuple, so the list stays exhaustive in both directions.
 */
const ALL_CHECK_NAMES = [
  "client_switch.transcript_painted",
  "client_switch.stalled",
  "client_switch.abandoned",
  "client_resume.request_count",
  "client_list.drain",
] as const satisfies readonly ClientPerfCheckName[];

type AssertNever<T extends never> = T;

type _UncoveredCheckNames = AssertNever<
  Exclude<ClientPerfCheckName, (typeof ALL_CHECK_NAMES)[number]>
>;

beforeEach(() => {
  consent = true;
  nativeIOS = false;
  nativeAndroid = false;
  postTelemetryEventsMock.mockClear();
  postTelemetryEventsMock.mockImplementation(() => {});
  detectClientOsMock.mockClear();
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

  test("emits every check name in the union verbatim", () => {
    for (const checkName of ALL_CHECK_NAMES) {
      emitClientPerfEvent(checkName, 1);
      expect(lastEvent().check_name).toBe(checkName);
    }
  });

  test("groups events from the same page load under one page_load_id", () => {
    emitClientPerfEvent("client_list.drain", 1);
    const first = lastDetail().page_load_id;
    expect(typeof first).toBe("string");
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

  test("probes the client OS once per emit", () => {
    emitClientPerfEvent("client_list.drain", 1);
    expect(detectClientOsMock).toHaveBeenCalledTimes(1);
  });

  test("labels the native shells from the platform predicates", () => {
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail().surface).toBe("web");

    nativeIOS = true;
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail().surface).toBe("ios_native");

    nativeIOS = false;
    nativeAndroid = true;
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail().surface).toBe("android_native");
  });

  test("still emits when crypto.randomUUID is unavailable", () => {
    const cryptoObject = globalThis.crypto as unknown as {
      randomUUID?: () => string;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      cryptoObject,
      "randomUUID",
    );
    Object.defineProperty(cryptoObject, "randomUUID", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      expect(() => {
        emitClientPerfEvent("client_list.drain", 1);
      }).not.toThrow();

      expect(postTelemetryEventsMock).toHaveBeenCalledTimes(1);

      const event = lastEvent();
      expect(typeof event.daemon_event_id).toBe("string");
      const pageLoadId = lastDetail().page_load_id;
      expect(typeof pageLoadId).toBe("string");

      emitClientPerfEvent("client_list.drain", 2);
      expect(lastDetail().page_load_id).toBe(pageLoadId);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(cryptoObject, "randomUUID", originalDescriptor);
      } else {
        delete cryptoObject.randomUUID;
      }
    }
  });
});
