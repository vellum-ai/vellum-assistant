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

beforeEach(() => {
  initMock.mockClear();
  identifyMock.mockClear();
  delete window._lrAsyncScript;
  if (provider.isActive()) provider.stop();
});

describe("replay provider (first-party proxy)", () => {
  test("init points the recorder script and ingest at our own origin", () => {
    provider.init("app-123", {
      environment: "test",
      release: "1.2.3",
      surface: "web",
      base: BASE,
    });

    // Recorder script served first-party (set before init).
    expect(window._lrAsyncScript).toBe(`${BASE}/_sr/cdn/logger.min.js`);

    // Ingest server routed through our proxy; no vendor host leaks.
    expect(initMock).toHaveBeenCalledTimes(1);
    const [appId, options] = initMock.mock.calls[0]!;
    expect(appId).toBe("app-123");
    expect(options.serverURL).toBe(`${BASE}/_sr/ingest/i`);
    expect(options.release).toBe("1.2.3");
    // Defaults to the apex root hostname when VITE_ROOT_HOSTNAME is unset.
    expect(options.rootHostname).toBe(".vellum.ai");
    expect(provider.isActive()).toBe(true);
  });

  test("identify forwards only defined traits plus surface", () => {
    provider.init("app-123", {
      environment: "test",
      surface: "macos",
      base: BASE,
    });
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
