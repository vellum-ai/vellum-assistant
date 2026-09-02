import { afterEach, describe, test, expect, mock } from "bun:test";
import type { DesktopStreamSocketData } from "../http/routes/desktop-stream-websocket.js";
import {
  GUARDIAN_PRINCIPAL,
  createFakeDownstreamWs,
  makeConfig,
  makeFakeServer,
  mintEdgeToken,
  upgradedData,
} from "./runtime-stream-test-utils.js";

// The pin itself is covered in `guardian-pin.test.ts`; the binding is mocked
// here only so the route can be shown to wire it in.
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: async () => ({ principalId: GUARDIAN_PRINCIPAL }),
}));

const {
  createDesktopStreamWebsocketHandler,
  getDesktopStreamWebsocketHandlers,
} = await import("../http/routes/desktop-stream-websocket.js");

// ---------------------------------------------------------------------------
// createDesktopStreamWebsocketHandler: upgrade handler tests
// ---------------------------------------------------------------------------

describe("createDesktopStreamWebsocketHandler", () => {
  const upgrade = async (token: string, upgradeResult = true) => {
    const handler = createDesktopStreamWebsocketHandler(makeConfig());
    const server = makeFakeServer(upgradeResult);
    const req = new Request(
      `http://localhost:7830/v1/desktop/stream?token=${token}`,
      { headers: { upgrade: "websocket" } },
    );
    return { res: await handler(req, server), server };
  };

  test("upgrades the bound guardian", async () => {
    const { res, server } = await upgrade(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData<DesktopStreamSocketData>(server)).toMatchObject({
      wsType: "desktop-stream",
    });
  });

  /**
   * The proxy replaces the caller's identity upstream, so whoever this upgrade
   * admits gets the pod's desktop. The route has to opt into the pin.
   */
  test("refuses a non-guardian actor", async () => {
    const { res, server } = await upgrade(mintEdgeToken("someone-else"));

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 500 when the Bun upgrade fails", async () => {
    const { res } = await upgrade(mintEdgeToken(GUARDIAN_PRINCIPAL), false);

    expect(res!.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// getDesktopStreamWebsocketHandlers: the byte pipe, against a real upstream
// ---------------------------------------------------------------------------

/**
 * RFB is a binary protocol, and noVNC reads the socket as RFB and nothing
 * else, so these run the pump against a real loopback WebSocket server posing
 * as the runtime: bytes have to arrive byte-identical in both directions, and
 * the runtime's close code has to arrive as itself.
 */
describe("getDesktopStreamWebsocketHandlers", () => {
  type FakeRuntime = {
    server: ReturnType<typeof Bun.serve>;
    received: Uint8Array[];
    /** Resolves with the upstream socket once the pump has dialed in. */
    connected: Promise<import("bun").ServerWebSocket<unknown>>;
    upgradeUrl: () => URL | undefined;
  };

  /** A loopback server that records what it is sent and echoes a banner. */
  function startFakeRuntime(banner?: Uint8Array): FakeRuntime {
    const received: Uint8Array[] = [];
    let upgradeUrl: URL | undefined;
    let resolveConnected!: (ws: import("bun").ServerWebSocket<unknown>) => void;
    const connected = new Promise<import("bun").ServerWebSocket<unknown>>(
      (resolve) => {
        resolveConnected = resolve;
      },
    );
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        upgradeUrl = new URL(req.url);
        if (srv.upgrade(req)) {
          return undefined as never;
        }
        return new Response("not a websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          if (banner) {
            ws.send(banner);
          }
          resolveConnected(ws);
        },
        message(_ws, message) {
          received.push(
            typeof message === "string"
              ? new TextEncoder().encode(message)
              : new Uint8Array(message),
          );
        },
        close() {},
      },
    });
    return { server, received, connected, upgradeUrl: () => upgradeUrl };
  }

  /** A viewer socket whose pump dials `runtime`. */
  function makeViewerWs(runtime: FakeRuntime, sendStatus?: number) {
    return createFakeDownstreamWs<DesktopStreamSocketData>(
      {
        wsType: "desktop-stream",
        config: makeConfig({
          assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
        }),
      },
      { sendStatus },
    );
  }

  /** Poll until `predicate` holds, so the tests need no fixed sleeps. */
  async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for condition");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** The RFB version banner, the first thing a VNC server sends. */
  const RFB_BANNER = new TextEncoder().encode("RFB 003.008\n");

  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  test("dials the runtime's /v1/desktop/stream with a service token and nothing else", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime);

    handlers.open(ws as never);
    await runtime.connected;

    const url = runtime.upgradeUrl()!;
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  test("delivers the runtime's bytes downstream byte-identical", async () => {
    runtime = startFakeRuntime(RFB_BANNER);
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime);

    handlers.open(ws as never);
    await waitFor(() => ws.sent.length > 0);

    const frame = ws.sent[0]!;
    expect(typeof frame).not.toBe("string");
    expect(Array.from(frame as Uint8Array)).toEqual(Array.from(RFB_BANNER));
    expect(ws.closes).toEqual([]);
  });

  /**
   * Past Bun's backpressure limit a send is dropped, and a missing frame
   * corrupts an ordered RFB stream: the viewer cannot resync, so both sides
   * are closed instead.
   */
  test("closes both sides when a downstream send is dropped", async () => {
    runtime = startFakeRuntime(RFB_BANNER);
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime, 0);

    handlers.open(ws as never);
    const upstreamClose = mock(ws.data.upstream!.close.bind(ws.data.upstream));
    ws.data.upstream!.close = upstreamClose;
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 1011, reason: "Viewer too slow" });
    expect(upstreamClose).toHaveBeenCalledWith(1011, "Viewer too slow");
  });

  test("delivers the viewer's bytes upstream byte-identical, including frames sent before the dial completes", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime);
    // Every byte value, so a text-vs-binary or encoding slip cannot hide.
    const early = new Uint8Array(256).map((_, i) => i);
    const late = new Uint8Array([0xff, 0x00, 0x7f, 0x80]);

    handlers.open(ws as never);
    handlers.message(ws as never, early);
    await runtime.connected;
    await waitFor(() => runtime.received.length === 1);
    handlers.message(ws as never, late);
    await waitFor(() => runtime.received.length === 2);

    expect(Array.from(runtime.received[0]!)).toEqual(Array.from(early));
    expect(Array.from(runtime.received[1]!)).toEqual(Array.from(late));
  });

  test("propagates the runtime's close code downstream verbatim", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime);

    handlers.open(ws as never);
    const upstream = await runtime.connected;
    upstream.close(4013, "desktop busy");
    await waitFor(() => ws.closes.length > 0);

    expect(ws.closes[0]).toEqual({ code: 4013, reason: "desktop busy" });
  });

  test("propagates the viewer's close code upstream verbatim", async () => {
    runtime = startFakeRuntime();
    const handlers = getDesktopStreamWebsocketHandlers();
    const ws = makeViewerWs(runtime);

    handlers.open(ws as never);
    await runtime.connected;
    const upstreamClose = mock(ws.data.upstream!.close.bind(ws.data.upstream));
    ws.data.upstream!.close = upstreamClose;

    handlers.close(ws as never, 4001, "viewer left");

    expect(upstreamClose).toHaveBeenCalledWith(4001, "viewer left");
    expect(ws.data.pendingMessages).toBeUndefined();
  });
});
