import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger from cdp-inspect-client.
mock.module("../../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Import under test AFTER mock.module calls so that the module's
// top-level logger import resolves to our fake.
const { CdpInspectClient, createCdpInspectClient } =
  await import("../cdp-inspect-client.js");
const { CdpError } = await import("../errors.js");
const { CdpWsTransportError } = await import("../cdp-inspect/ws-transport.js");

type CdpInspectClientInstance = InstanceType<typeof CdpInspectClient>;

/**
 * Minimal fake CdpWsTransport used by the test harness below. The
 * handler is per-send so individual tests can model success, CDP
 * errors, transport errors, and abort behavior on specific methods.
 */
interface FakeTransportOptions {
  onSend?: (
    method: string,
    params: Record<string, unknown> | undefined,
    opts: { sessionId?: string; signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
  trackSends?: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }>;
  trackDisposeCount?: { count: number };
}

function createFakeTransport(options: FakeTransportOptions) {
  const transport = {
    send: async <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      opts?: { sessionId?: string; signal?: AbortSignal },
    ): Promise<T> => {
      options.trackSends?.push({
        method,
        params,
        sessionId: opts?.sessionId,
      });
      if (options.onSend) {
        const result = await options.onSend(method, params, opts ?? {});
        return result as T;
      }
      return undefined as T;
    },
    addEventListener: () => () => {},
    dispose: () => {
      if (options.trackDisposeCount) {
        options.trackDisposeCount.count += 1;
      }
    },
  };
  return transport;
}

/**
 * Build a client wired to mocked discovery + transport helpers. The
 * caller supplies handlers for the moving pieces; everything else
 * defaults to a happy-path attach.
 */
interface HarnessOptions {
  probeImpl?: (opts: unknown) => Promise<{
    browser: string;
    protocolVersion: string;
    webSocketDebuggerUrl: string;
  }>;
  listImpl?: (opts: unknown) => Promise<
    Array<{
      id: string;
      type: string;
      title: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>
  >;
  connectImpl?: (
    url: string,
    opts?: { connectTimeoutMs?: number },
  ) => Promise<ReturnType<typeof createFakeTransport>>;
  transportOnSend?: FakeTransportOptions["onSend"];
  conversationId?: string;
}

interface Harness {
  client: CdpInspectClientInstance;
  sends: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }>;
  disposeCount: { count: number };
  probeCalls: number;
  listCalls: number;
  connectCalls: number;
  attachCallCount: () => number;
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const sends: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  const disposeCount = { count: 0 };
  let probeCalls = 0;
  let listCalls = 0;
  let connectCalls = 0;

  // Track Target.attachToTarget specifically so tests can assert
  // how many attach attempts the client has made.
  const attachSends: Array<unknown> = [];

  const defaultOnSend: FakeTransportOptions["onSend"] = (method) => {
    if (method === "Target.attachToTarget") {
      attachSends.push(method);
      return { sessionId: "fake-session-id" };
    }
    return { ok: true };
  };

  const transportOnSend: FakeTransportOptions["onSend"] = async (
    method,
    params,
    o,
  ) => {
    if (method === "Target.attachToTarget") {
      attachSends.push(method);
    }
    if (opts.transportOnSend) {
      return opts.transportOnSend(method, params, o);
    }
    return defaultOnSend!(method, params, o);
  };

  const client = createCdpInspectClient(opts.conversationId ?? "conv-1", {
    host: "127.0.0.1",
    port: 9222,
    discoveryTimeoutMs: 100,
    wsConnectTimeoutMs: 100,
    helpers: {
      probeDevToolsJsonVersion: async (probeOpts: unknown) => {
        probeCalls += 1;
        if (opts.probeImpl) return opts.probeImpl(probeOpts);
        return {
          browser: "Chrome/125.0.0.0",
          protocolVersion: "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
        };
      },
      listDevToolsTargets: async (listOpts: unknown) => {
        listCalls += 1;
        if (opts.listImpl) return opts.listImpl(listOpts);
        return [
          {
            id: "target-1",
            type: "page",
            title: "Example",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
          },
        ];
      },
      // pickDefaultTarget uses the real implementation — it's pure.
      connectCdpWsTransport: async (
        url: string,
        connectOpts?: { connectTimeoutMs?: number },
      ) => {
        connectCalls += 1;
        if (opts.connectImpl) return opts.connectImpl(url, connectOpts);
        return createFakeTransport({
          onSend: transportOnSend,
          trackSends: sends,
          trackDisposeCount: disposeCount,
        });
      },
    },
  });

  return {
    client,
    sends,
    disposeCount,
    get probeCalls() {
      return probeCalls;
    },
    get listCalls() {
      return listCalls;
    },
    get connectCalls() {
      return connectCalls;
    },
    attachCallCount: () => attachSends.length,
  };
}

describe("CdpInspectClient", () => {
  beforeEach(() => {
    // no-op — each test gets its own harness
  });

  test("kind is 'cdp-inspect' and exposes conversationId", () => {
    const { client } = createHarness({ conversationId: "conv-kind" });
    expect(client).toBeInstanceOf(CdpInspectClient);
    expect(client.kind).toBe("cdp-inspect");
    expect(client.conversationId).toBe("conv-kind");
  });

  test("send() probes version, lists targets, attaches, and forwards the call", async () => {
    const harness = createHarness({
      transportOnSend: (method) => {
        if (method === "Target.attachToTarget") {
          return { sessionId: "session-abc" };
        }
        if (method === "Browser.getVersion") {
          return { product: "HeadlessChrome/125.0.0.0" };
        }
        return undefined;
      },
    });
    const result = await harness.client.send<{ product: string }>(
      "Browser.getVersion",
    );
    expect(result).toEqual({ product: "HeadlessChrome/125.0.0.0" });
    expect(harness.probeCalls).toBe(1);
    expect(harness.listCalls).toBe(1);
    expect(harness.connectCalls).toBe(1);
    // One attach + one forwarded Browser.getVersion.
    expect(harness.sends).toEqual([
      {
        method: "Target.attachToTarget",
        params: { targetId: "target-1", flatten: true },
        sessionId: undefined,
      },
      {
        method: "Browser.getVersion",
        params: undefined,
        sessionId: "session-abc",
      },
    ]);
  });

  test("multiple send() calls share a single attach", async () => {
    const harness = createHarness();
    await harness.client.send("Runtime.enable");
    await harness.client.send("Page.enable");
    await harness.client.send("DOM.enable");
    expect(harness.probeCalls).toBe(1);
    expect(harness.listCalls).toBe(1);
    expect(harness.connectCalls).toBe(1);
    expect(harness.attachCallCount()).toBe(1);
    expect(harness.sends.length).toBe(4); // 1 attach + 3 forwarded
  });

  test("concurrent send() calls share a single in-flight attach", async () => {
    const harness = createHarness();
    await Promise.all([
      harness.client.send("Runtime.enable"),
      harness.client.send("Page.enable"),
      harness.client.send("DOM.enable"),
    ]);
    expect(harness.probeCalls).toBe(1);
    expect(harness.listCalls).toBe(1);
    expect(harness.connectCalls).toBe(1);
    expect(harness.attachCallCount()).toBe(1);
  });

  test("send() retries ensureSession after an initial attach failure", async () => {
    // First probe call rejects (simulating e.g. Chrome not yet listening).
    // Second probe call succeeds. Because the cached sessionPromise must
    // be cleared on rejection, the second send() performs a full retry.
    let probeCount = 0;
    const harness = createHarness({
      probeImpl: async () => {
        probeCount += 1;
        if (probeCount === 1) {
          throw new Error("connect ECONNREFUSED");
        }
        return {
          browser: "Chrome/125.0.0.0",
          protocolVersion: "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
        };
      },
    });

    let firstErr: unknown;
    try {
      await harness.client.send("Browser.getVersion");
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(CdpError);
    expect((firstErr as InstanceType<typeof CdpError>).code).toBe(
      "transport_error",
    );
    expect(probeCount).toBe(1);
    expect(harness.connectCalls).toBe(0);

    // Second call — cached promise was cleared, so probe + list +
    // connect + attach all run again, then the forwarded call
    // resolves normally.
    const result = await harness.client.send<{ ok: boolean }>(
      "Browser.getVersion",
    );
    expect(result).toEqual({ ok: true });
    expect(probeCount).toBe(2);
    expect(harness.listCalls).toBe(2);
    expect(harness.connectCalls).toBe(1);
    expect(harness.attachCallCount()).toBe(1);
  });

  test("send() maps CDP protocol errors from attach to CdpError 'cdp_error'", async () => {
    const harness = createHarness({
      transportOnSend: async (method) => {
        if (method === "Target.attachToTarget") {
          throw new CdpWsTransportError(
            "cdp_error",
            "No target with given id found",
            {
              cdpMethod: "Target.attachToTarget",
              cdpCode: -32602,
              cdpMessage: "No target with given id found",
            },
          );
        }
        return undefined;
      },
    });

    let caught: unknown;
    try {
      await harness.client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("cdp_error");
    expect(cdpErr.message).toBe("No target with given id found");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    expect(cdpErr.underlying).toBeInstanceOf(CdpWsTransportError);
  });

  test("send() maps transport failures during attach to CdpError 'transport_error'", async () => {
    const harness = createHarness({
      connectImpl: async () => {
        throw new CdpWsTransportError(
          "transport_error",
          "websocket closed before open",
        );
      },
    });
    let caught: unknown;
    try {
      await harness.client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("transport_error");
    expect(cdpErr.message).toBe("websocket closed before open");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
  });

  test("send() with an already-aborted signal throws 'aborted' without touching the transport", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await harness.client.send(
        "Browser.getVersion",
        undefined,
        controller.signal,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    // Nothing ran — no discovery, no connect, no transport sends.
    expect(harness.probeCalls).toBe(0);
    expect(harness.listCalls).toBe(0);
    expect(harness.connectCalls).toBe(0);
    expect(harness.sends.length).toBe(0);
  });

  test("send() classifies as 'aborted' when the signal fires during attach", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      probeImpl: async () => {
        // Simulate caller aborting while discovery is in flight.
        // Discovery itself throws a generic error (as real fetch
        // would), and the abort flag is flipped — we expect the
        // resulting CdpError to carry code "aborted".
        controller.abort();
        throw new Error("aborted during fetch");
      },
    });
    let caught: unknown;
    try {
      await harness.client.send(
        "Browser.getVersion",
        undefined,
        controller.signal,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
  });

  test("send() classifies as 'aborted' when the signal fires during the forwarded call", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      transportOnSend: async (method) => {
        if (method === "Target.attachToTarget") {
          return { sessionId: "session-abc" };
        }
        // Simulate the transport throwing an abort error after
        // the caller aborts mid-call.
        controller.abort();
        throw new CdpWsTransportError("aborted", "aborted during send", {
          cdpMethod: method,
        });
      },
    });
    let caught: unknown;
    try {
      await harness.client.send(
        "Page.navigate",
        { url: "about:blank" },
        controller.signal,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Page.navigate");
  });

  test("send() maps forwarded CDP protocol errors to 'cdp_error'", async () => {
    const harness = createHarness({
      transportOnSend: async (method) => {
        if (method === "Target.attachToTarget") {
          return { sessionId: "session-abc" };
        }
        throw new CdpWsTransportError("cdp_error", "invalid expression", {
          cdpMethod: method,
          cdpCode: -32000,
          cdpMessage: "invalid expression",
        });
      },
    });
    let caught: unknown;
    try {
      await harness.client.send("Runtime.evaluate", { expression: "??" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("cdp_error");
    expect(cdpErr.message).toBe("invalid expression");
    expect(cdpErr.cdpMethod).toBe("Runtime.evaluate");
    expect(cdpErr.cdpParams).toEqual({ expression: "??" });
  });

  test("dispose() is idempotent and tears down the underlying transport", async () => {
    const harness = createHarness();
    await harness.client.send("Browser.getVersion");
    harness.client.dispose();
    // dispose schedules transport.dispose on the resolved attach
    // promise's then() — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.disposeCount.count).toBe(1);

    // Second dispose is a no-op.
    harness.client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.disposeCount.count).toBe(1);
  });

  test("dispose() without any sends does not call connectCdpWsTransport", async () => {
    const harness = createHarness();
    harness.client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.connectCalls).toBe(0);
    expect(harness.disposeCount.count).toBe(0);
  });

  test("send() after dispose throws CdpError with code 'disposed'", async () => {
    const harness = createHarness();
    harness.client.dispose();
    let caught: unknown;
    try {
      await harness.client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("disposed");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    // No discovery or transport activity took place.
    expect(harness.probeCalls).toBe(0);
    expect(harness.listCalls).toBe(0);
    expect(harness.connectCalls).toBe(0);
  });

  test("attach that returns no sessionId throws 'cdp_error'", async () => {
    const harness = createHarness({
      transportOnSend: async (method) => {
        if (method === "Target.attachToTarget") {
          // Missing sessionId field — a broken fork response.
          return {};
        }
        return undefined;
      },
    });
    let caught: unknown;
    try {
      await harness.client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("cdp_error");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
  });

  test("attach failure tears down the partially-opened transport", async () => {
    const localDisposeCount = { count: 0 };
    const transport = createFakeTransport({
      onSend: async (method) => {
        if (method === "Target.attachToTarget") {
          throw new CdpWsTransportError("cdp_error", "attach failed", {
            cdpMethod: method,
          });
        }
        return undefined;
      },
      trackDisposeCount: localDisposeCount,
    });
    const client = createCdpInspectClient("conv-attach-fail", {
      host: "127.0.0.1",
      port: 9222,
      helpers: {
        probeDevToolsJsonVersion: async () => ({
          browser: "Chrome/125.0.0.0",
          protocolVersion: "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
        }),
        listDevToolsTargets: async () => [
          {
            id: "target-1",
            type: "page",
            title: "Example",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
          },
        ],
        connectCdpWsTransport: async () => transport,
      },
    });

    let caught: unknown;
    try {
      await client.send("Browser.getVersion");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    // The transport opened by attach() should have been disposed so
    // the socket doesn't leak.
    expect(localDisposeCount.count).toBe(1);
  });
});
