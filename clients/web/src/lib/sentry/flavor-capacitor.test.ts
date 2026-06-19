import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions, ErrorEvent } from "@sentry/react";

// ---------------------------------------------------------------------------
// Mock @sentry/capacitor + the sibling react init the flavor wraps.
// ---------------------------------------------------------------------------

let lastInitOptions: BrowserOptions | undefined;
const initMock = mock((options: BrowserOptions) => {
  lastInitOptions = options;
});
const closeMock = mock(() => Promise.resolve());
let client: { getOptions: () => { enabled?: boolean } } | undefined;

mock.module("@sentry/capacitor", () => ({
  init: initMock,
  close: closeMock,
  getClient: () => client,
}));
mock.module("@sentry/react", () => ({ init: mock(() => {}) }));

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
  lastInitOptions = undefined;
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
});

describe("capacitorFlavor.close", () => {
  test("shuts down both JS and native via Capacitor.close", () => {
    void capacitorFlavor.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
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
