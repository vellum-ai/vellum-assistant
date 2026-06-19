import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the vendor SDK so we can assert how the provider drives it without
// loading the real recorder. The provider imports it lazily (dynamic import),
// which mock.module intercepts the same as a static import.
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

/** Drain microtasks so the provider's lazy `import("logrocket")` resolves. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  initMock.mockClear();
  identifyMock.mockClear();
});

// The provider is a module singleton that lazily loads the SDK once, so these
// tests run as an ordered sequence: the first `init` loads + primes it.
describe("replay provider (first-party proxy, lazy load)", () => {
  test("defers the SDK load, then forwards proxied config + queued identify", async () => {
    let consent = true;
    provider.init("app-123", {
      environment: "test",
      release: "1.2.3",
      surface: "web",
      base: BASE,
      shouldSendData: () => consent,
      network: NETWORK,
    });

    // Recorder URL is set synchronously, pointing at our first-party proxy.
    expect(window._lrAsyncScript).toBe(`${BASE}/_sr/cdn/logger.min.js`);
    expect(provider.isActive()).toBe(true);

    // identify before the lazy import resolves must queue, not throw.
    provider.identify("u1", {
      name: "Alice Smith",
      email: "alice@example.com",
      surface: "web",
    });

    // Nothing touches the SDK synchronously — the import is deferred so the
    // recorder never loads at app startup (regression guard for the P1).
    expect(initMock).not.toHaveBeenCalled();
    expect(identifyMock).not.toHaveBeenCalled();

    await flush();

    // SDK init forwarded our proxied config.
    expect(initMock).toHaveBeenCalledTimes(1);
    const [appId, options] = initMock.mock.calls[0]!;
    expect(appId).toBe("app-123");
    expect(options.serverURL).toBe(`${BASE}/_sr/ingest/i`);
    expect(options.release).toBe("1.2.3");
    expect(options.rootHostname).toBe(".vellum.ai");
    expect(options.network).toBe(NETWORK);

    // The stats beacon (no init option) is routed through the proxy via the
    // SDK config object, so it never POSTs to the vendor host directly.
    expect(window.__SDKCONFIG__?.statsURL).toBe(`${BASE}/_sr/ingest/s`);

    // shouldSendData reflects live consent, re-checked before every upload.
    const shouldSendData = options.shouldSendData as () => boolean;
    expect(shouldSendData()).toBe(true);
    consent = false;
    expect(shouldSendData()).toBe(false);

    // The queued identify flushes once the SDK is loaded.
    expect(identifyMock).toHaveBeenCalledWith("u1", {
      surface: "web",
      name: "Alice Smith",
      email: "alice@example.com",
    });
  });

  test("init is one-shot: a revoke→re-grant within a page does not reload", async () => {
    provider.stop();
    expect(provider.isActive()).toBe(false);

    provider.init("app-123", {
      environment: "test",
      surface: "web",
      base: BASE,
      shouldSendData: () => true,
      network: NETWORK,
    });
    await flush();

    // Already loaded — must not import/init the SDK again.
    expect(initMock).not.toHaveBeenCalled();
    expect(provider.isActive()).toBe(true);
  });

  test("identify after load dispatches directly", () => {
    provider.identify("u2", { username: "bob", surface: "macos" });

    expect(identifyMock).toHaveBeenCalledWith("u2", {
      surface: "macos",
      username: "bob",
    });
  });
});
