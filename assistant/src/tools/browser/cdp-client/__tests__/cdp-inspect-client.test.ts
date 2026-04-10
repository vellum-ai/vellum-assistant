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
  // how many attach attempts the client has made. The counter is
  // bumped ONLY in the default happy-path branch so tests that
  // install a custom `transportOnSend` (and therefore model their
  // own attach semantics) can't accidentally double-count.
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
    // resolves normally. listCalls is only 1 because the first
    // attempt threw inside probeDevToolsJsonVersion before it ever
    // reached listDevToolsTargets.
    const result = await harness.client.send<{ ok: boolean }>(
      "Browser.getVersion",
    );
    expect(result).toEqual({ ok: true });
    expect(probeCount).toBe(2);
    expect(harness.listCalls).toBe(1);
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

  test("send() aborts promptly when signal fires during ensureSession", async () => {
    // Discovery is deliberately stalled so the caller has to rely on
    // raceAbort() to cut through. If raceAbort worked correctly, the
    // send() promise rejects with an 'aborted' CdpError the instant
    // the controller fires — even though probeDevToolsJsonVersion is
    // still hanging on an unresolved await.
    const controller = new AbortController();
    let probeSignalSeen: AbortSignal | undefined;
    let probeResolve: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      probeResolve = resolve;
    });

    const client = createCdpInspectClient("conv-abort-during-ensure", {
      host: "127.0.0.1",
      port: 9222,
      helpers: {
        probeDevToolsJsonVersion: async (probeOpts) => {
          // Capture the signal so we can assert the shared attach
          // controller actually fired downstream.
          probeSignalSeen = (probeOpts as { signal?: AbortSignal }).signal;
          probeResolve?.();
          // Hang forever unless the shared controller fires.
          await new Promise<never>((_, reject) => {
            const onAbort = () => {
              reject(new Error("probe aborted via shared controller"));
            };
            if (probeSignalSeen?.aborted) {
              onAbort();
            } else {
              probeSignalSeen?.addEventListener("abort", onAbort, {
                once: true,
              });
            }
          });
          throw new Error("unreachable");
        },
        listDevToolsTargets: async () => [
          {
            id: "target-1",
            type: "page",
            title: "Example",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
          },
        ],
        connectCdpWsTransport: async () =>
          createFakeTransport({
            onSend: async (method) => {
              if (method === "Target.attachToTarget") {
                return { sessionId: "fake-session-id" };
              }
              return undefined;
            },
          }),
      },
    });

    const sendPromise = client.send(
      "Browser.getVersion",
      undefined,
      controller.signal,
    );
    // Wait until probe is actually running, then abort.
    await probeStarted;
    controller.abort();

    let caught: unknown;
    try {
      await sendPromise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as InstanceType<typeof CdpError>;
    expect(cdpErr.code).toBe("aborted");
    expect(cdpErr.cdpMethod).toBe("Browser.getVersion");
    // Probe saw a non-null signal, meaning ensureSession plumbed one
    // all the way down to the discovery helper.
    expect(probeSignalSeen).toBeDefined();
    // After the last (and only) waiter aborted, the shared controller
    // should have been aborted — downstream probe's await should have
    // been rejected.
    expect(probeSignalSeen?.aborted).toBe(true);
  });

  test("a new send() after all waiters abort starts a fresh attach", async () => {
    // Regression test for the race condition where onAbort aborts
    // the shared controller but `this.pending` is only cleared later
    // via the async `.catch()` handler in startAttach(). A new caller
    // entering ensureSession() between those two events would reuse
    // the already-aborted pending attach and immediately fail with an
    // `aborted` error even though it never aborted its own signal.
    //
    // Fix: onAbort now clears `this.pending` synchronously BEFORE
    // firing the shared controller.abort(), so any new caller after
    // the abort starts a fresh attach.
    let probeCount = 0;
    let listCount = 0;
    let connectCount = 0;

    // The first probe hangs until the shared controller aborts it.
    // The second probe (from the fresh attach) resolves normally.
    const firstProbeStarted = Promise.withResolvers<void>();

    const client = createCdpInspectClient("conv-race", {
      host: "127.0.0.1",
      port: 9222,
      helpers: {
        probeDevToolsJsonVersion: async (probeOpts) => {
          probeCount += 1;
          const signal = (probeOpts as { signal?: AbortSignal }).signal;
          if (probeCount === 1) {
            firstProbeStarted.resolve();
            // Stall until the shared controller aborts us.
            await new Promise<never>((_, reject) => {
              const onAbort = () => {
                reject(new Error("probe aborted via shared controller"));
              };
              if (signal?.aborted) {
                onAbort();
              } else {
                signal?.addEventListener("abort", onAbort, { once: true });
              }
            });
            throw new Error("unreachable");
          }
          return {
            browser: "Chrome/125.0.0.0",
            protocolVersion: "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
          };
        },
        listDevToolsTargets: async () => {
          listCount += 1;
          return [
            {
              id: "target-1",
              type: "page",
              title: "Example",
              url: "https://example.com/",
              webSocketDebuggerUrl:
                "ws://127.0.0.1:9222/devtools/page/target-1",
            },
          ];
        },
        connectCdpWsTransport: async () => {
          connectCount += 1;
          return createFakeTransport({
            onSend: async (method) => {
              if (method === "Target.attachToTarget") {
                return { sessionId: "session-race" };
              }
              return { ok: true };
            },
          });
        },
      },
    });

    // 1. First caller kicks off the attach with signal A.
    const signalA = new AbortController();
    const firstSend = client.send("Runtime.enable", undefined, signalA.signal);

    // 2. Wait until the first probe has actually started so we know
    //    the attach is in-flight and signal A is the only waiter.
    await firstProbeStarted.promise;

    // 3. Abort signal A. Because it's the only waiter, onAbort will
    //    fire the shared controller and (with the fix) clear
    //    `this.pending` synchronously.
    signalA.abort();

    // First caller should reject with `aborted`.
    let firstErr: unknown;
    try {
      await firstSend;
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(CdpError);
    expect((firstErr as InstanceType<typeof CdpError>).code).toBe("aborted");

    // At this point, with the fix, `this.pending` has been cleared
    // synchronously — but without the fix, it would still be set to
    // the aborted pending until the `.catch()` handler in
    // startAttach() runs asynchronously. We intentionally do NOT
    // flush microtasks here before kicking off the second send() so
    // that we exercise the race window.
    //
    // 4. New send() with its own signal B. With the fix, this should
    //    start a fresh attach and complete successfully. Without the
    //    fix, it would reuse the aborted pending and fail with an
    //    `aborted` error even though signal B was never aborted.
    const signalB = new AbortController();
    const secondSend = client.send("Page.enable", undefined, signalB.signal);

    // Second caller should succeed.
    const secondResult = await secondSend;
    expect(secondResult).toEqual({ ok: true });

    // 5. Assert that the second send() kicked off a fresh attach —
    //    probe, list, and connect should all have been called twice.
    expect(probeCount).toBe(2);
    expect(listCount).toBe(1);
    expect(connectCount).toBe(1);
    // listCount and connectCount are 1 because the first attach
    // aborted during the probe stage — it never reached list or
    // connect. The second (fresh) attach ran probe + list + connect
    // all once.
  });

  test("concurrent send() callers can abort independently", async () => {
    // Two callers race the same in-flight attach. The first caller
    // aborts; the second caller must still complete normally once the
    // shared attach resolves.
    const aborter = new AbortController();
    let probeResolve: (() => void) | undefined;
    let releaseProbe: (() => void) | undefined;
    const probeRunning = new Promise<void>((resolve) => {
      probeResolve = resolve;
    });
    const probeCanFinish = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });

    const harness = createHarness({
      probeImpl: async () => {
        probeResolve?.();
        await probeCanFinish;
        return {
          browser: "Chrome/125.0.0.0",
          protocolVersion: "1.3",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake",
        };
      },
    });

    const aborted = harness.client.send(
      "Runtime.enable",
      undefined,
      aborter.signal,
    );
    const stable = harness.client.send("Page.enable");

    await probeRunning;
    aborter.abort();

    // First caller aborts promptly…
    let firstErr: unknown;
    try {
      await aborted;
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(CdpError);
    expect((firstErr as InstanceType<typeof CdpError>).code).toBe("aborted");

    // …but the second caller is still alive and can make progress
    // once the shared attach finishes.
    releaseProbe?.();
    await stable;
    expect(harness.probeCalls).toBe(1);
    expect(harness.listCalls).toBe(1);
    expect(harness.connectCalls).toBe(1);
    expect(harness.attachCallCount()).toBe(1);
  });
});
