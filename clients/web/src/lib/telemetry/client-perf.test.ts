/**
 * Pins the shared `client_*` transport and emitter:
 *   - One relay POST per event, addressed to the active assistant, carrying
 *     the watchdog `fields` shape with `keepalive` set.
 *   - No active assistant means no POST: the event has no relay target.
 *   - Nothing is emitted without analytics consent.
 *   - A throwing or rejecting transport never propagates to the caller.
 *   - The page-load key is minted lazily and survives a runtime with no
 *     `crypto.randomUUID` (non-secure contexts).
 *   - Surface and os come from a single platform probe per emit.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ClientPerfCheckName } from "./client-perf";

let consent = true;
let nativeIOS = false;
let nativeAndroid = false;
let activeAssistantId: string | null = "assistant-1";
const telemetryIngestPostMock = mock((_options: unknown) =>
  Promise.resolve({}),
);
const detectClientOsMock = mock(() => "web");

const captureErrorMock = mock(
  (_error: unknown, _opts: { context: string }) => {},
);
const actualCapture = await import("@/lib/sentry/capture-error");
mock.module("@/lib/sentry/capture-error", () => ({
  ...actualCapture,
  captureError: captureErrorMock,
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  telemetryIngestPost: telemetryIngestPostMock,
}));
mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => consent,
}));
// Minimal on purpose: `client-perf.ts` reads only `getState().activeAssistantId`,
// and the real store module drags the lockfile graph into the test.
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({ activeAssistantId }),
  },
}));
mock.module("@/runtime/platform-detection", () => ({
  detectClientOs: detectClientOsMock,
  isNativeIOS: () => nativeIOS,
  isNativeAndroid: () => nativeAndroid,
}));

const {
  __resetClientPerfForTests,
  emitClientPerfEvent,
  sendClientWatchdogEvent,
  setClientPerfBootId,
} = await import("./client-perf");

interface RelayCall {
  path: { assistant_id: string };
  body: {
    type: string;
    daemon_event_id?: string;
    fields: {
      check_name: string;
      value: number | null;
      detail: Record<string, unknown>;
    };
  };
  keepalive?: boolean;
}

function lastCall(): RelayCall {
  const call = telemetryIngestPostMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as RelayCall;
}

function lastDetail(): Record<string, unknown> {
  return lastCall().body.fields.detail;
}

/**
 * Every member of the exported union. `satisfies` rejects an entry that is not
 * a check name, and the `AssertNever` alias below rejects a check name that is
 * missing from the tuple, so the list stays exhaustive in both directions.
 */
const ALL_CHECK_NAMES = [
  "client_boot",
  "client_switch.transcript_painted",
  "client_switch.stalled",
  "client_switch.abandoned",
  "client_resume.request_count",
  "client_resume.to_sse_open",
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
  activeAssistantId = "assistant-1";
  telemetryIngestPostMock.mockClear();
  telemetryIngestPostMock.mockImplementation(() => Promise.resolve({}));
  captureErrorMock.mockClear();
  detectClientOsMock.mockClear();
  __resetClientPerfForTests();
});

describe("sendClientWatchdogEvent", () => {
  test("posts one watchdog event to the active assistant's relay with keepalive", () => {
    sendClientWatchdogEvent({
      checkName: "client_boot",
      value: 1820,
      detail: { boot_id: "boot-1" },
      daemonEventId: "client_boot:boot-1",
    });

    const call = lastCall();
    expect(call.path.assistant_id).toBe("assistant-1");
    expect(call.body.type).toBe("watchdog");
    expect(call.body.daemon_event_id).toBe("client_boot:boot-1");
    expect(call.body.fields).toEqual({
      check_name: "client_boot",
      value: 1820,
      detail: { boot_id: "boot-1" },
    });
    // The request must survive a pagehide flush.
    expect(call.keepalive).toBe(true);
  });

  test("omits the collapse key when the caller has none, so the daemon mints one", () => {
    sendClientWatchdogEvent({
      checkName: "client_list.drain",
      value: 12,
      detail: {},
    });

    expect(lastCall().body).not.toHaveProperty("daemon_event_id");
  });

  test("passes a null value through for events with no scalar", () => {
    sendClientWatchdogEvent({
      checkName: "client_boot",
      value: null,
      detail: {},
    });

    expect(lastCall().body.fields.value).toBeNull();
  });

  test("routes to the caller's owning assistant over the active one", () => {
    // A switch completing mid-operation must not attribute the measurement,
    // and its consent decision, to the newly active assistant.
    sendClientWatchdogEvent({
      checkName: "client_list.drain",
      assistantId: "owner-of-the-drained-list",
      value: 12,
      detail: {},
    });

    expect(lastCall().path.assistant_id).toBe("owner-of-the-drained-list");
  });

  test("an explicit owner still sends when no assistant is active", () => {
    activeAssistantId = null;

    sendClientWatchdogEvent({
      checkName: "client_list.drain",
      assistantId: "owner-of-the-drained-list",
      value: 12,
      detail: {},
    });

    expect(lastCall().path.assistant_id).toBe("owner-of-the-drained-list");
  });

  test("drops the event when no assistant is resolved: there is no relay target", () => {
    activeAssistantId = null;

    sendClientWatchdogEvent({
      checkName: "client_boot",
      value: 1,
      detail: {},
    });

    expect(telemetryIngestPostMock).not.toHaveBeenCalled();
  });

  test("reports a non-404 rejection once per status, per page load", async () => {
    telemetryIngestPostMock.mockImplementation(() =>
      Promise.resolve({ response: { ok: false, status: 400 } }),
    );

    sendClientWatchdogEvent({ checkName: "client_boot", value: 1, detail: {} });
    sendClientWatchdogEvent({ checkName: "client_boot", value: 2, detail: {} });
    await Bun.sleep(0);

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect((captureErrorMock.mock.calls[0]![0] as Error).message).toContain(
      "400",
    );
  });

  test("stays quiet on 404: a daemon predating the relay route is expected", async () => {
    telemetryIngestPostMock.mockImplementation(() =>
      Promise.resolve({ response: { ok: false, status: 404 } }),
    );

    sendClientWatchdogEvent({ checkName: "client_boot", value: 1, detail: {} });
    await Bun.sleep(0);

    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test.each([401, 403])(
    "stays quiet on %i: the auth layer refusing the caller is expected",
    async (status) => {
      telemetryIngestPostMock.mockImplementation(() =>
        Promise.resolve({ response: { ok: false, status } }),
      );

      sendClientWatchdogEvent({
        checkName: "client_boot",
        value: 1,
        detail: {},
      });
      await Bun.sleep(0);

      expect(captureErrorMock).not.toHaveBeenCalled();
    },
  );

  test("stays quiet on 5xx: an unreachable daemon is transport, not contract", async () => {
    telemetryIngestPostMock.mockImplementation(() =>
      Promise.resolve({ response: { ok: false, status: 503 } }),
    );

    sendClientWatchdogEvent({ checkName: "client_boot", value: 1, detail: {} });
    await Bun.sleep(0);

    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("swallows a rejecting transport", async () => {
    telemetryIngestPostMock.mockImplementation(() =>
      Promise.reject(new Error("relay down")),
    );

    expect(() => {
      sendClientWatchdogEvent({
        checkName: "client_boot",
        value: 1,
        detail: {},
      });
    }).not.toThrow();
    // Let the rejection settle; an unhandled rejection would fail the file.
    await Bun.sleep(0);
  });

  test("swallows a synchronously throwing transport", () => {
    telemetryIngestPostMock.mockImplementation(() => {
      throw new Error("transport down");
    });
    expect(() => {
      sendClientWatchdogEvent({
        checkName: "client_boot",
        value: 1,
        detail: {},
      });
    }).not.toThrow();
  });
});

describe("emitClientPerfEvent", () => {
  test("emits one event with a rounded value and the perf detail bag", () => {
    emitClientPerfEvent("client_switch.transcript_painted", 412.7);

    const { fields } = lastCall().body;
    expect(fields.check_name).toBe("client_switch.transcript_painted");
    expect(fields.value).toBe(413);

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
      expect(lastCall().body.fields.check_name).toBe(checkName);
    }
  });

  test("groups events from the same page load under one page_load_id", () => {
    emitClientPerfEvent("client_list.drain", 1);
    const first = lastDetail().page_load_id;
    expect(typeof first).toBe("string");
    emitClientPerfEvent("client_list.drain", 2);
    expect(lastDetail().page_load_id).toBe(first);
  });

  test("threads the owning assistant through to the relay path", () => {
    emitClientPerfEvent("client_list.drain", 3, {}, "owner-a");
    expect(lastCall().path.assistant_id).toBe("owner-a");
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
    expect(telemetryIngestPostMock).not.toHaveBeenCalled();
  });

  test("omits boot_id until one is registered", () => {
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail()).not.toHaveProperty("boot_id");

    setClientPerfBootId("boot-123");
    emitClientPerfEvent("client_list.drain", 1);
    expect(lastDetail().boot_id).toBe("boot-123");
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

      expect(telemetryIngestPostMock).toHaveBeenCalledTimes(1);
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
