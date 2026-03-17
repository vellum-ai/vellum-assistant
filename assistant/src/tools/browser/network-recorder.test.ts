import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

// Mock the logger to avoid side effects during tests
mock.module("../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const { NetworkRecorder } = await import("./network-recorder.js");

describe("NetworkRecorder", () => {
  describe("startDirect CDP URL passthrough", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls: string[];

    beforeEach(() => {
      fetchCalls = [];
      // Mock fetch to capture the URL and return a valid CDP version response.
      globalThis.fetch = (async (url: string | URL | Request) => {
        fetchCalls.push(String(url));
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl: "ws://localhost:1234/devtools/browser/fake",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    // Safety net: restore fetch even if afterEach is skipped due to a test error
    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    it("uses constructor-provided cdpBaseUrl when called without arguments", async () => {
      const customBase = "http://custom-host:9333";
      const recorder = new NetworkRecorder(undefined, customBase);

      // startDirect will fail at the WebSocket connect step, but we only
      // care that fetch was called with the correct URL.
      try {
        await recorder.startDirect();
      } catch {
        // Expected - WebSocket connection will fail in test environment
      }

      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      expect(fetchCalls[0]).toBe(`${customBase}/json/version`);
      expect(fetchCalls[0]).not.toContain("undefined");
    });

    it("uses explicit cdpBaseUrl argument when provided", async () => {
      const constructorBase = "http://constructor-host:9222";
      const explicitBase = "http://explicit-host:9444";
      const recorder = new NetworkRecorder(undefined, constructorBase);

      try {
        await recorder.startDirect(explicitBase);
      } catch {
        // Expected - WebSocket connection will fail in test environment
      }

      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      expect(fetchCalls[0]).toBe(`${explicitBase}/json/version`);
    });
  });
});
