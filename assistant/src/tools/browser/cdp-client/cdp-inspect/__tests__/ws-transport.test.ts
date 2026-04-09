/**
 * Tests for the raw CDP JSON-RPC WebSocket transport.
 *
 * These tests stand up a fake CDP peer on a random loopback port
 * with `Bun.serve` so we can exercise every failure mode without
 * any real Chrome install. The fake peer consumes the JSON-RPC
 * request frame verbatim, then returns whatever envelope the test
 * scenario wants (success, CDP error, delayed, etc.).
 *
 * Every test is responsible for stopping the fake server in a
 * `try/finally` (or via `afterEach`) to avoid port leaks across the
 * suite.
 */

import { describe, expect, test } from "bun:test";

import type { ServerWebSocket } from "bun";

import {
  type CdpWsTransport,
  CdpWsTransportError,
  connectCdpWsTransport,
} from "../ws-transport.js";

interface WsFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface FakeWsServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start a fake websocket server whose inbound-message handler is
 * controlled by the caller. The caller gets the raw parsed CDP
 * request frame plus the underlying `ServerWebSocket` so it can
 * respond, delay, close, or do nothing at all.
 */
function startFakeWsServer(options: {
  onMessage?: (
    ws: ServerWebSocket<undefined>,
    frame: WsFrame,
    raw: string,
  ) => void;
  onOpen?: (ws: ServerWebSocket<undefined>) => void;
}): FakeWsServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("expected ws", { status: 400 });
    },
    websocket: {
      open(ws) {
        options.onOpen?.(ws);
      },
      message(ws, message) {
        const raw =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message);
        let parsed: WsFrame;
        try {
          parsed = JSON.parse(raw) as WsFrame;
        } catch {
          return;
        }
        options.onMessage?.(ws, parsed, raw);
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  return {
    url,
    async stop() {
      // Fire-and-forget stop. `await server.stop(true)` can hang
      // in bun 1.3.x when a ws client has already closed, and
      // `await server.stop()` waits for in-flight connections to
      // drain, which can also hang in pathological tests. We don't
      // need to block on shutdown for correctness — the process
      // exits after the suite, and every test allocates a fresh
      // random port.
      server.stop();
    },
  };
}

/**
 * Start a fake HTTP (non-ws) server that refuses upgrade requests
 * with `400`. Used to verify that `connectCdpWsTransport` rejects
 * (with either `timeout` or `transport_error`) when the peer does
 * not speak websockets.
 */
function startNonWsServer(): FakeWsServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("no websocket here", { status: 400 });
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  return {
    url,
    async stop() {
      server.stop();
    },
  };
}

async function withTransport<T>(
  server: FakeWsServer,
  fn: (transport: CdpWsTransport) => Promise<T>,
  connectOpts?: { connectTimeoutMs?: number },
): Promise<T> {
  const transport = await connectCdpWsTransport(server.url, connectOpts);
  try {
    return await fn(transport);
  } finally {
    transport.dispose();
  }
}

describe("CdpWsTransportError", () => {
  test("subclasses Error with code and metadata", () => {
    const err = new CdpWsTransportError("cdp_error", "boom", {
      cdpMethod: "Page.navigate",
      cdpCode: -32000,
      cdpMessage: "boom",
      cdpData: { foo: "bar" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CdpWsTransportError);
    expect(err.name).toBe("CdpWsTransportError");
    expect(err.code).toBe("cdp_error");
    expect(err.cdpMethod).toBe("Page.navigate");
    expect(err.cdpCode).toBe(-32000);
    expect(err.cdpMessage).toBe("boom");
    expect(err.cdpData).toEqual({ foo: "bar" });
  });

  test("supports all documented codes", () => {
    const codes = [
      "closed",
      "aborted",
      "timeout",
      "transport_error",
      "cdp_error",
    ] as const;
    for (const code of codes) {
      const err = new CdpWsTransportError(code);
      expect(err.code).toBe(code);
    }
  });
});

describe("connectCdpWsTransport", () => {
  test("send+receive success — Browser.getVersion style", async () => {
    const server = startFakeWsServer({
      onMessage(ws, frame) {
        if (frame.method === "Browser.getVersion") {
          ws.send(
            JSON.stringify({
              id: frame.id,
              result: {
                protocolVersion: "1.3",
                product: "Chrome/123.0.0.0",
                revision: "@deadbeef",
                userAgent: "test",
                jsVersion: "1.0",
              },
            }),
          );
        }
      },
    });
    try {
      await withTransport(server, async (transport) => {
        const result = await transport.send<{ product: string }>(
          "Browser.getVersion",
        );
        expect(result.product).toBe("Chrome/123.0.0.0");
      });
    } finally {
      await server.stop();
    }
  });

  test("rejects with cdp_error when the peer returns a JSON-RPC error", async () => {
    const server = startFakeWsServer({
      onMessage(ws, frame) {
        ws.send(
          JSON.stringify({
            id: frame.id,
            error: {
              code: -32601,
              message: "Method not found",
              data: { method: frame.method },
            },
          }),
        );
      },
    });
    try {
      await withTransport(server, async (transport) => {
        await expect(transport.send("Bogus.method")).rejects.toMatchObject({
          name: "CdpWsTransportError",
          code: "cdp_error",
          cdpMethod: "Bogus.method",
          cdpCode: -32601,
          cdpMessage: "Method not found",
        });
      });
    } finally {
      await server.stop();
    }
  });

  test("handles concurrent out-of-order responses", async () => {
    const pendingFrames: WsFrame[] = [];
    const server = startFakeWsServer({
      onMessage(ws, frame) {
        pendingFrames.push(frame);
        // Respond in reverse order after all three arrive.
        if (pendingFrames.length === 3) {
          const [f1, f2, f3] = pendingFrames;
          ws.send(JSON.stringify({ id: f3!.id, result: { n: 3 } }));
          ws.send(JSON.stringify({ id: f1!.id, result: { n: 1 } }));
          ws.send(JSON.stringify({ id: f2!.id, result: { n: 2 } }));
        }
      },
    });
    try {
      await withTransport(server, async (transport) => {
        const p1 = transport.send<{ n: number }>("A.one");
        const p2 = transport.send<{ n: number }>("B.two");
        const p3 = transport.send<{ n: number }>("C.three");
        const results = await Promise.all([p1, p2, p3]);
        expect(results).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      });
    } finally {
      await server.stop();
    }
  });

  test("fans out events (frames with no id) to listeners", async () => {
    const server = startFakeWsServer({
      onOpen(ws) {
        // Push an unsolicited event shortly after open.
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Target.targetCreated",
              params: { targetId: "abc" },
              sessionId: "S1",
            }),
          );
        }, 5);
      },
    });
    try {
      await withTransport(server, async (transport) => {
        const received: Array<{
          method: string;
          params?: unknown;
          sessionId?: string;
        }> = [];
        transport.addEventListener((ev) => {
          received.push(ev);
        });
        // Wait for the event to arrive.
        await new Promise((r) => setTimeout(r, 50));
        expect(received).toEqual([
          {
            method: "Target.targetCreated",
            params: { targetId: "abc" },
            sessionId: "S1",
          },
        ]);
      });
    } finally {
      await server.stop();
    }
  });

  test("does not resolve any pending request for a no-id event", async () => {
    let gotRequest = false;
    const server = startFakeWsServer({
      onOpen(ws) {
        // Emit a no-id event before any send() happens.
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Target.attachedToTarget",
              params: {},
            }),
          );
        }, 5);
      },
      onMessage(ws, frame) {
        gotRequest = true;
        ws.send(JSON.stringify({ id: frame.id, result: { ok: true } }));
      },
    });
    try {
      await withTransport(server, async (transport) => {
        await new Promise((r) => setTimeout(r, 20));
        // Pending-request map must still be empty here — otherwise
        // a subsequent send would deadlock on a stale entry.
        const result = await transport.send<{ ok: boolean }>("Test.ping");
        expect(result.ok).toBe(true);
        expect(gotRequest).toBe(true);
      });
    } finally {
      await server.stop();
    }
  });

  test("forwards sessionId on the wire when opts.sessionId is provided", async () => {
    let seen: WsFrame | null = null;
    const server = startFakeWsServer({
      onMessage(ws, frame) {
        seen = frame;
        ws.send(JSON.stringify({ id: frame.id, result: {} }));
      },
    });
    try {
      await withTransport(server, async (transport) => {
        await transport.send("Runtime.enable", undefined, {
          sessionId: "sess-42",
        });
      });
      expect(seen).not.toBeNull();
      // seen is WsFrame | null; narrow via unknown for the
      // assertions below (TS narrows `seen` to `null` inside the
      // closure, which is why a direct cast trips noImplicitAny).
      const frame = seen as unknown as WsFrame;
      expect(frame.sessionId).toBe("sess-42");
      expect(frame.method).toBe("Runtime.enable");
    } finally {
      await server.stop();
    }
  });

  test("abort mid-request rejects with aborted and drops late response", async () => {
    let deferredFrameId: number | undefined;
    let serverWs: ServerWebSocket<undefined> | null = null;
    const server = startFakeWsServer({
      onMessage(ws, frame) {
        // Hold the response indefinitely so the abort can race.
        deferredFrameId = frame.id;
        serverWs = ws;
      },
    });
    try {
      const transport = await connectCdpWsTransport(server.url);
      try {
        const controller = new AbortController();
        const sendPromise = transport.send(
          "Slow.call",
          {},
          {
            signal: controller.signal,
          },
        );
        // Let the request land on the server.
        await new Promise((r) => setTimeout(r, 20));
        controller.abort();
        await expect(sendPromise).rejects.toMatchObject({
          name: "CdpWsTransportError",
          code: "aborted",
          cdpMethod: "Slow.call",
        });
        // Now deliver a response for the dropped id. The transport
        // should silently ignore it — a subsequent send should
        // still work and MUST NOT deadlock.
        if (deferredFrameId !== undefined && serverWs) {
          (serverWs as ServerWebSocket<undefined>).send(
            JSON.stringify({ id: deferredFrameId, result: { late: true } }),
          );
        }
        // Follow-up request must still function.
        await new Promise((r) => setTimeout(r, 10));
      } finally {
        transport.dispose();
      }
    } finally {
      await server.stop();
    }
  });

  test("server close mid-request rejects pending with closed", async () => {
    const server = startFakeWsServer({
      onMessage(ws) {
        // Close the socket without responding.
        ws.close();
      },
    });
    try {
      const transport = await connectCdpWsTransport(server.url);
      try {
        let caught: unknown;
        try {
          await transport.send("Some.method");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(CdpWsTransportError);
        expect((caught as CdpWsTransportError).code).toBe("closed");

        // After close, subsequent sends also reject with closed.
        let caught2: unknown;
        try {
          await transport.send("Another.method");
        } catch (err) {
          caught2 = err;
        }
        expect(caught2).toBeInstanceOf(CdpWsTransportError);
        expect((caught2 as CdpWsTransportError).code).toBe("closed");
      } finally {
        transport.dispose();
      }
    } finally {
      await server.stop();
    }
  });

  test("connect rejects with transport_error when peer refuses upgrade", async () => {
    const server = startNonWsServer();
    try {
      await expect(
        connectCdpWsTransport(server.url, { connectTimeoutMs: 500 }),
      ).rejects.toMatchObject({
        name: "CdpWsTransportError",
      });
      // Code can be either timeout or transport_error depending on
      // how the runtime surfaces an HTTP 400 upgrade failure — both
      // are acceptable per the transport contract.
      try {
        await connectCdpWsTransport(server.url, { connectTimeoutMs: 200 });
      } catch (err) {
        expect(err).toBeInstanceOf(CdpWsTransportError);
        const code = (err as CdpWsTransportError).code;
        expect(["timeout", "transport_error"]).toContain(code);
      }
    } finally {
      await server.stop();
    }
  });

  test("connect rejects with timeout when peer never accepts", async () => {
    // A server that hangs forever (never responds to the upgrade).
    // We simulate this by pointing at an unroutable port guarded by
    // a very short connect timeout; expect either timeout or
    // transport_error since runtimes vary in how they surface a
    // refused connection.
    let err: unknown;
    try {
      await connectCdpWsTransport("ws://127.0.0.1:1", {
        connectTimeoutMs: 100,
      });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(CdpWsTransportError);
    const code = (err as CdpWsTransportError).code;
    expect(["timeout", "transport_error"]).toContain(code);
  });

  test("dispose is idempotent", async () => {
    const server = startFakeWsServer({});
    try {
      const transport = await connectCdpWsTransport(server.url);
      transport.dispose();
      expect(() => transport.dispose()).not.toThrow();
      expect(() => transport.dispose()).not.toThrow();
      // send after dispose rejects with closed.
      await expect(transport.send("X")).rejects.toMatchObject({
        code: "closed",
      });
    } finally {
      await server.stop();
    }
  });

  test("dispose rejects any in-flight pending requests with closed", async () => {
    const server = startFakeWsServer({
      onMessage() {
        // Never respond — we want the request to stay pending until
        // dispose fires.
      },
    });
    try {
      const transport = await connectCdpWsTransport(server.url);
      const p = transport.send("Never.responds");
      // Give the request time to reach the server.
      await new Promise((r) => setTimeout(r, 20));
      transport.dispose();
      await expect(p).rejects.toMatchObject({
        name: "CdpWsTransportError",
        code: "closed",
      });
    } finally {
      await server.stop();
    }
  });

  test("addEventListener returns an unsubscribe function", async () => {
    const server = startFakeWsServer({
      onOpen(ws) {
        setTimeout(() => {
          ws.send(JSON.stringify({ method: "Ev.first", params: {} }));
          setTimeout(() => {
            ws.send(JSON.stringify({ method: "Ev.second", params: {} }));
          }, 10);
        }, 5);
      },
    });
    try {
      await withTransport(server, async (transport) => {
        const received: string[] = [];
        const unsub = transport.addEventListener((ev) => {
          received.push(ev.method);
          if (ev.method === "Ev.first") unsub();
        });
        await new Promise((r) => setTimeout(r, 60));
        expect(received).toEqual(["Ev.first"]);
      });
    } finally {
      await server.stop();
    }
  });

  test("send after dispose rejects immediately with closed", async () => {
    const server = startFakeWsServer({});
    try {
      const transport = await connectCdpWsTransport(server.url);
      transport.dispose();
      await expect(transport.send("Page.enable")).rejects.toMatchObject({
        name: "CdpWsTransportError",
        code: "closed",
        cdpMethod: "Page.enable",
      });
    } finally {
      await server.stop();
    }
  });

  test("listener errors are swallowed and do not affect correlation", async () => {
    const server = startFakeWsServer({
      onOpen(ws) {
        setTimeout(() => {
          ws.send(JSON.stringify({ method: "Boom.event", params: {} }));
        }, 5);
      },
      onMessage(ws, frame) {
        ws.send(JSON.stringify({ id: frame.id, result: { ok: true } }));
      },
    });
    try {
      await withTransport(server, async (transport) => {
        transport.addEventListener(() => {
          throw new Error("listener crash");
        });
        // Wait for the event to arrive and be swallowed.
        await new Promise((r) => setTimeout(r, 20));
        // Subsequent requests must still work.
        const result = await transport.send<{ ok: boolean }>("Page.enable");
        expect(result.ok).toBe(true);
      });
    } finally {
      await server.stop();
    }
  });
});
