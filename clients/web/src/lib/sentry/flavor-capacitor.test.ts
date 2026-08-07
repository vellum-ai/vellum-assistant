import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions, ErrorEvent } from "@sentry/react";

// ---------------------------------------------------------------------------
// Mock @sentry/capacitor + the sibling react init the flavor wraps.
// ---------------------------------------------------------------------------

let lastInitOptions: BrowserOptions | undefined;
let siblingInit: ((options: BrowserOptions) => void) | undefined;
const shutdownOrder: string[] = [];
const initMock = mock(
  (
    options: BrowserOptions,
    originalInit?: (options: BrowserOptions) => void,
  ) => {
    lastInitOptions = options;
    siblingInit = originalInit;
  },
);
const closeMock = mock(() => {
  shutdownOrder.push("sentry");
  return Promise.resolve();
});
const reactInitMock = mock((_options: BrowserOptions) => {});
const startNativeFailureReportForwardingMock = mock(() => Promise.resolve());
const stopNativeFailureReportForwardingMock = mock(() => {
  shutdownOrder.push("reports");
  return Promise.resolve();
});
let client: { getOptions: () => { enabled?: boolean } } | undefined;

mock.module("@sentry/capacitor", () => ({
  init: initMock,
  close: closeMock,
  getClient: () => client,
}));
mock.module("@sentry/react", () => ({ init: reactInitMock }));
mock.module("@/runtime/native-failure-reports", () => ({
  startNativeFailureReportForwarding: startNativeFailureReportForwardingMock,
  stopNativeFailureReportForwarding: stopNativeFailureReportForwardingMock,
}));

// Controllable composed gate the flavor's beforeSend reads.
let consent = false;
mock.module("@/lib/sentry/consent-gate", () => ({
  diagnosticsConsentGranted: () => consent,
}));

const { capacitorFlavor } = await import("@/lib/sentry/flavor-capacitor");

const OPTIONS: BrowserOptions = { dsn: "https://public@example.test/1" };
const anEvent = (): ErrorEvent =>
  ({ event_id: "abc", type: undefined }) as ErrorEvent;

beforeEach(() => {
  initMock.mockClear();
  closeMock.mockClear();
  reactInitMock.mockClear();
  startNativeFailureReportForwardingMock.mockClear();
  stopNativeFailureReportForwardingMock.mockClear();
  shutdownOrder.length = 0;
  lastInitOptions = undefined;
  siblingInit = undefined;
  client = undefined;
  consent = false;
});

describe("capacitorFlavor.init", () => {
  test("enables the client and forwards options", () => {
    capacitorFlavor.init(OPTIONS);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(lastInitOptions?.enabled).toBe(true);
    expect(lastInitOptions?.dsn).toBe(OPTIONS.dsn);
  });

  test("starts native failure forwarding after the Sentry client initializes", () => {
    capacitorFlavor.init(OPTIONS);
    expect(startNativeFailureReportForwardingMock).not.toHaveBeenCalled();

    siblingInit?.(OPTIONS);

    expect(reactInitMock).toHaveBeenCalledWith(OPTIONS);
    expect(startNativeFailureReportForwardingMock).toHaveBeenCalledTimes(1);
  });

  test("beforeSend drops JS-bridged events when consent is off", () => {
    consent = false;
    capacitorFlavor.init(OPTIONS);
    const beforeSend = lastInitOptions?.beforeSend;
    expect(beforeSend).toBeDefined();
    expect(beforeSend?.(anEvent(), {})).toBeNull();
  });

  test("beforeSend keeps events when consent is on", () => {
    consent = true;
    capacitorFlavor.init(OPTIONS);
    const event = anEvent();
    expect(lastInitOptions?.beforeSend?.(event, {})).toBe(event);
  });

  test("beforeSend reads the LIVE gate (revocation after init drops events)", () => {
    consent = true;
    capacitorFlavor.init(OPTIONS);
    const beforeSend = lastInitOptions?.beforeSend;
    consent = false; // user opts out after the client was initialized
    expect(beforeSend?.(anEvent(), {})).toBeNull();
  });

  test("composes the caller's beforeSend instead of replacing it", () => {
    // The caller's hook carries diagnostic enrichment that every surface
    // should get and must apply to every native mobile shell.
    consent = true;
    const enriched = { event_id: "enriched" } as ErrorEvent;
    capacitorFlavor.init({ ...OPTIONS, beforeSend: () => enriched });

    expect(lastInitOptions?.beforeSend?.(anEvent(), {})).toBe(enriched);
  });

  test("consent is checked before the caller's beforeSend runs", () => {
    consent = false;
    let callerRan = false;
    capacitorFlavor.init({
      ...OPTIONS,
      beforeSend: (event) => {
        callerRan = true;
        return event;
      },
    });

    expect(lastInitOptions?.beforeSend?.(anEvent(), {})).toBeNull();
    expect(callerRan).toBe(false);
  });
});

describe("capacitorFlavor.close", () => {
  test("disables queued reports before shutting down Sentry", async () => {
    await capacitorFlavor.close();
    expect(stopNativeFailureReportForwardingMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(shutdownOrder).toEqual(["reports", "sentry"]);
  });
});

describe("capacitorFlavor.getClientEnabled", () => {
  test("false when no client is installed", () => {
    client = undefined;
    expect(capacitorFlavor.getClientEnabled()).toBe(false);
  });

  test("true when an enabled client is installed", () => {
    client = { getOptions: () => ({ enabled: true }) };
    expect(capacitorFlavor.getClientEnabled()).toBe(true);
  });

  test("false when the installed client is disabled", () => {
    client = { getOptions: () => ({ enabled: false }) };
    expect(capacitorFlavor.getClientEnabled()).toBe(false);
  });
});
