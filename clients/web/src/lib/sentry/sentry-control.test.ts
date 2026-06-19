import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserOptions } from "@sentry/react";

import type { SentryFlavor } from "@/lib/sentry/flavor";

const initMock = mock((_options: BrowserOptions) => {});
const closeMock = mock(() => {});
let clientEnabled = false;

const flavor: SentryFlavor = {
  init: initMock,
  close: closeMock,
  getClientEnabled: () => clientEnabled,
};
const selectSentryFlavorMock = mock(() => flavor);

mock.module("@/lib/sentry/flavor", () => ({
  selectSentryFlavor: selectSentryFlavorMock,
}));

let consent = false;
const watchCallbacks: Array<() => void> = [];
const unwatchMock = mock(() => {});

mock.module("@/utils/device-settings", () => ({
  getDeviceBool: (_name: string, fallback: boolean) =>
    consent ? true : fallback,
  watchDeviceSetting: (_name: string, callback: () => void) => {
    watchCallbacks.push(callback);
    return unwatchMock;
  },
}));

const { syncSentryClient, installSentryControlListeners } = await import(
  "@/lib/sentry/sentry-control"
);

const options: BrowserOptions = { dsn: "https://public@example.com/1" };

beforeEach(() => {
  initMock.mockClear();
  closeMock.mockClear();
  selectSentryFlavorMock.mockClear();
  unwatchMock.mockClear();
  watchCallbacks.length = 0;
  consent = false;
  clientEnabled = false;
});

describe("syncSentryClient", () => {
  test("dispatches through the selected flavor", () => {
    consent = true;
    syncSentryClient(options);
    expect(selectSentryFlavorMock).toHaveBeenCalled();
  });

  test("no-ops when dsn is absent (never touches the flavor)", () => {
    consent = true;
    syncSentryClient({});
    expect(initMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  test("inits the flavor when consented and no client is enabled", () => {
    consent = true;
    clientEnabled = false;
    syncSentryClient(options);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]![0]).toBe(options);
    expect(closeMock).not.toHaveBeenCalled();
  });

  test("does not re-init when consented and a client is already enabled", () => {
    consent = true;
    clientEnabled = true;
    syncSentryClient(options);
    expect(initMock).not.toHaveBeenCalled();
  });

  test("closes the flavor when consent is absent", () => {
    consent = false;
    syncSentryClient(options);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(initMock).not.toHaveBeenCalled();
  });
});

describe("installSentryControlListeners", () => {
  test("re-syncs through the flavor when the toggle changes", () => {
    const cleanup = installSentryControlListeners(options);
    expect(watchCallbacks).toHaveLength(1);

    consent = true;
    watchCallbacks[0]!();
    expect(initMock).toHaveBeenCalledTimes(1);

    expect(cleanup).toBe(unwatchMock);
  });
});
