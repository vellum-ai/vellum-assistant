import { afterEach, describe, test, expect, mock } from "bun:test";
import type { WatchStreamSocketData } from "../http/routes/watch-stream-websocket.js";
import {
  GUARDIAN_PRINCIPAL,
  createFakeDownstreamWs,
  makeConfig,
  makeFakeServer,
  mintEdgeToken,
  mintServiceEdgeToken,
  settle,
  startFakeRuntime,
  upgradedData,
  waitFor,
  type FakeRuntime,
} from "./runtime-stream-test-utils.js";

// The pin itself is covered in `guardian-pin.test.ts`; the binding is mocked
// here only so the route can be shown to wire it in.
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: async () => ({ principalId: GUARDIAN_PRINCIPAL }),
}));

const { createWatchStreamWebsocketHandler, getWatchStreamWebsocketHandlers } =
  await import("../http/routes/watch-stream-websocket.js");

// ---------------------------------------------------------------------------
// createWatchStreamWebsocketHandler: upgrade handler tests
// ---------------------------------------------------------------------------

describe("createWatchStreamWebsocketHandler", () => {
  const TEST_TOKEN = mintEdgeToken();

  test("upgrades when the token query parameter is valid", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&sampleRate=16000`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
    expect(upgradedData<WatchStreamSocketData>(server)).toMatchObject({
      wsType: "watch-stream",
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });
  });

  test("upgrades when the Authorization header is valid", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      {
        headers: {
          upgrade: "websocket",
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      },
    );
    const server = makeFakeServer();

    expect(await handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("carries an explicit conversation and host client through", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=conv-1&clientId=host-1`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handler(req, server);

    expect(upgradedData<WatchStreamSocketData>(server)).toMatchObject({
      conversationId: "conv-1",
      clientId: "host-1",
    });
  });

  /**
   * A session with no conversation named is the companion surface's Watch,
   * which starts a session rather than joining a thread. Blank has to read the
   * same as absent, or the runtime would be handed an empty id to file against.
   */
  test("reads blank optional parameters as absent", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm&conversationId=%20&clientId=`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    await handler(req, server);

    const data = upgradedData<WatchStreamSocketData>(server);
    expect(data.conversationId).toBeUndefined();
    expect(data.clientId).toBeUndefined();
  });

  test("returns 401 when no token is provided", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 401 when the token is invalid", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?token=bad-token&mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  /**
   * The client-facing half of the proxy takes actors and nothing else. A
   * service credential reaching it would open a user's microphone stream on a
   * token minted for machine to machine traffic.
   */
  test("returns 401 for a service token, which has no actor principal", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintServiceEdgeToken()}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 400 when mimeType is missing", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(400);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(426);
  });

  test("returns 500 when the Bun upgrade fails", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${TEST_TOKEN}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer(false);
    const res = await handler(req, server);

    expect(res!.status).toBe(500);
  });

  test("allows an unauthenticated upgrade when auth is disabled (dev bypass)", async () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request(
      "http://localhost:7830/v1/watch/stream?mimeType=audio/pcm",
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();

    expect(await handler(req, server)).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledTimes(1);
  });

  test("still requires mimeType when auth is disabled", async () => {
    const handler = createWatchStreamWebsocketHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request("http://localhost:7830/v1/watch/stream", {
      headers: { upgrade: "websocket" },
    });
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(400);
  });

  /**
   * Watch reads the owner's screen, and the proxy replaces the caller's
   * identity upstream, so the route has to opt into the guardian pin.
   */
  test("refuses a non-guardian actor", async () => {
    const handler = createWatchStreamWebsocketHandler(makeConfig());
    const req = new Request(
      `http://localhost:7830/v1/watch/stream?token=${mintEdgeToken("someone-else")}&mimeType=audio/pcm`,
      { headers: { upgrade: "websocket" } },
    );
    const server = makeFakeServer();
    const res = await handler(req, server);

    expect(res!.status).toBe(403);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getWatchStreamWebsocketHandlers: WS lifecycle tests
// ---------------------------------------------------------------------------

describe("getWatchStreamWebsocketHandlers", () => {
  const makeWatchWs = () =>
    createFakeDownstreamWs<WatchStreamSocketData>({
      wsType: "watch-stream",
      config: makeConfig(),
      mimeType: "audio/pcm",
      sampleRate: 16000,
    });

  test("open initializes the pending message buffer", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();

    // Dialing upstream fails in a test process; the buffer is set up first.
    try {
      handlers.open(ws as never);
    } catch {
      // The WebSocket constructor may throw here.
    }

    expect(ws.data.pendingMessages).toBeDefined();
  });

  /**
   * The client starts sending the moment its own socket opens, which is before
   * this proxy has an upstream to send to. The first fraction of a second of
   * narration is exactly the part a transcriber needs.
   */
  test("message buffers frames that arrive before upstream connects", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();
    ws.data.pendingMessages = [];

    handlers.message(ws as never, "narration-frame");

    expect(ws.data.pendingMessages).toContain("narration-frame");
  });

  test("message closes the socket rather than buffering without bound", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();
    ws.data.pendingMessages = new Array(100).fill("x");

    handlers.message(ws as never, "overflow-frame");

    expect(ws.close).toHaveBeenCalledWith(1008, "Buffer overflow");
  });

  test("message forwards straight through once upstream is open", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();
    ws.data.pendingMessages = [];
    const upstream = {
      readyState: WebSocket.OPEN,
      send: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.message(ws as never, "narration-frame");

    expect(upstream.send).toHaveBeenCalledWith("narration-frame");
    expect(ws.data.pendingMessages).toEqual([]);
  });

  test("close releases the buffer and closes upstream with the same code", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();
    ws.data.pendingMessages = ["some-data"];
    const upstream = {
      readyState: WebSocket.OPEN,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(ws.data.pendingMessages).toBeUndefined();
    expect(upstream.close).toHaveBeenCalledWith(1000, "normal");
  });

  test("close is safe when upstream is already gone", async () => {
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeWatchWs();
    const upstream = {
      readyState: WebSocket.CLOSED,
      close: mock(() => {}),
    };
    ws.data.upstream = upstream as unknown as WebSocket;

    handlers.close(ws as never, 1000, "normal");

    expect(upstream.close).not.toHaveBeenCalled();
  });
});

/**
 * Watch carries JSON lifecycle and timeline frames, each self-contained. A
 * dropped one costs a fragment, not the session, so the desktop stream's
 * teardown must not reach this route: the usual trigger is a runtime frame
 * landing just after the browser socket closed.
 */
describe("a dropped downstream frame does not end a watch session", () => {
  let runtime: FakeRuntime;
  afterEach(() => {
    runtime?.server.stop(true);
  });

  const makeViewerWs = (sendStatus?: number) =>
    createFakeDownstreamWs<WatchStreamSocketData>(
      {
        wsType: "watch-stream",
        config: makeConfig({
          assistantRuntimeBaseUrl: `http://127.0.0.1:${runtime.server.port}`,
        }),
        mimeType: "audio/pcm",
      },
      { sendStatus },
    );

  test("keeps both sides open when a send is dropped", async () => {
    runtime = startFakeRuntime('{"type":"session_started"}');
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeViewerWs(0);

    handlers.open(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
    expect(ws.data.upstream!.readyState).toBe(WebSocket.OPEN);
  });

  test("does not treat an empty frame as a dropped one", async () => {
    runtime = startFakeRuntime("");
    const handlers = getWatchStreamWebsocketHandlers();
    const ws = makeViewerWs(0);

    handlers.open(ws as never);
    await waitFor(() => ws.sent.length > 0);
    await settle();

    expect(ws.closes).toEqual([]);
  });
});
