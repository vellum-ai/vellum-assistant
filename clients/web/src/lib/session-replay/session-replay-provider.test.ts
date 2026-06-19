import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the vendor SDK so we can assert how the provider drives it without
// loading the real recorder.
const initMock = mock((_appId: string, _options: Record<string, unknown>) => {});
const identifyMock = mock(
  (_uid: string, _traits: Record<string, string>) => {},
);
mock.module("logrocket", () => ({
  default: { init: initMock, identify: identifyMock },
}));

const { provider } = await import(
  "@/lib/session-replay/session-replay-provider"
);

const BASE = "https://app.example.com";
const NETWORK = {
  requestSanitizer: <T>(r: T) => r,
  responseSanitizer: <T>(r: T) => r,
  isEnabled: true,
};

beforeEach(() => {
  initMock.mockClear();
  identifyMock.mockClear();
});

// The provider is a module singleton with one-shot init, so these tests run as
// an ordered sequence: the first `init` primes the SDK for the rest.
describe("replay provider (first-party proxy, singleton lifecycle)", () => {
  test("init points recorder + ingest at our origin and wires the consent gate", () => {
    let consent = true;
    provider.init("app-123", {
      environment: "test",
      release: "1.2.3",
      surface: "web",
      base: BASE,
      shouldSendData: () => consent,
      network: NETWORK,
    });

    // Recorder script served first-party (set before init).
    expect(window._lrAsyncScript).toBe(`${BASE}/_sr/cdn/logger.min.js`);

    // Ingest routed through our proxy; no vendor host leaks.
    expect(initMock).toHaveBeenCalledTimes(1);
    const [appId, options] = initMock.mock.calls[0]!;
    expect(appId).toBe("app-123");
    expect(options.serverURL).toBe(`${BASE}/_sr/ingest/i`);
    expect(options.release).toBe("1.2.3");
    // Defaults to the apex root hostname when VITE_ROOT_HOSTNAME is unset.
    expect(options.rootHostname).toBe(".vellum.ai");
    // Network sanitizers are forwarded to the SDK's network config.
    expect(options.network).toBe(NETWORK);
    expect(provider.isActive()).toBe(true);

    // The SDK re-checks shouldSendData before every upload, so a mid-session
    // revoke halts ingestion live rather than at next reload.
    const shouldSendData = options.shouldSendData as () => boolean;
    expect(shouldSendData()).toBe(true);
    consent = false;
    expect(shouldSendData()).toBe(false);
  });

  test("init is one-shot: a revoke→re-grant within a page does not re-init", () => {
    provider.stop();
    expect(provider.isActive()).toBe(false);

    provider.init("app-123", {
      environment: "test",
      surface: "web",
      base: BASE,
      shouldSendData: () => true,
      network: NETWORK,
    });

    // Re-running init must not call the SDK again — the recorder can't be
    // cleanly re-init'd mid-page; consent gating is what (un)pauses uploads.
    expect(initMock).not.toHaveBeenCalled();
    // ...but the provider counts as active again so re-identify can fire.
    expect(provider.isActive()).toBe(true);
  });

  test("identify forwards only defined traits plus surface", () => {
    provider.identify("u1", {
      name: "Alice Smith",
      email: "alice@example.com",
      surface: "macos",
    });

    expect(identifyMock).toHaveBeenCalledWith("u1", {
      surface: "macos",
      name: "Alice Smith",
      email: "alice@example.com",
    });
  });
});
