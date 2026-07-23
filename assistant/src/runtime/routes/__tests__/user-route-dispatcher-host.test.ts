import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RouteInvokeParams } from "../../../routes/route-host-protocol.js";
import { getWorkspaceRoutesDir } from "../../../util/platform.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import type { UserRouteContext } from "../user-route-dispatcher.js";

// The dispatcher constructs the route host client inline and reads the enabled
// flag from config, so both are mocked here (there is no injection seam).
interface RouteInvokeResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array | null;
}
interface InvokeCall {
  params: RouteInvokeParams;
  body: Uint8Array | null;
}

let hostEnabled = false;
let invokeImpl: (call: InvokeCall) => Promise<RouteInvokeResponse>;
const invokeCalls: InvokeCall[] = [];
const ctorOptions: ({ invokeTimeoutMs?: number } | undefined)[] = [];

class FakeTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`route handler timed out after ${timeoutMs}ms`);
  }
}
class FakeUnavailableError extends Error {}

mock.module("../../../routes/control.js", () => ({
  isRouteHostEnabled: () => hostEnabled,
}));
mock.module("../../../routes/route-host-client.js", () => ({
  RouteHostClient: class {
    constructor(options?: { invokeTimeoutMs?: number }) {
      ctorOptions.push(options);
    }
    async invoke(params: RouteInvokeParams, body: Uint8Array | null) {
      const call = { params, body };
      invokeCalls.push(call);
      return invokeImpl(call);
    }
  },
  RouteHostTimeoutError: FakeTimeoutError,
  RouteHostUnavailableError: FakeUnavailableError,
}));

const { UserRouteDispatcher } = await import("../user-route-dispatcher.js");

function context(): UserRouteContext {
  return {
    assistantEventHub: new AssistantEventHub(),
    conversations: { postMessage: async () => ({ messageId: "m" }) },
  };
}

function makeDispatcher() {
  return new UserRouteDispatcher({ context: context() });
}

function writeHandler(name: string, content: string): void {
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
  writeFileSync(join(getWorkspaceRoutesDir(), name), content);
}

function jsonResponse(status: number, value: unknown): RouteInvokeResponse {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

beforeEach(() => {
  hostEnabled = false;
  invokeImpl = async () => jsonResponse(200, { via: "host" });
  invokeCalls.length = 0;
  ctorOptions.length = 0;
});

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
});

describe("UserRouteDispatcher — route host delegation", () => {
  test("delegates to the host when enabled (in-band handler never runs)", async () => {
    // If the in-band path ran it would return {via:"in-band"}; the host reply
    // returns {via:"host"}, so the response distinguishes which path executed.
    writeHandler(
      "foo.ts",
      `export function GET() { return Response.json({ via: "in-band" }); }`,
    );
    hostEnabled = true;
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "foo",
      new Request("http://localhost/v1/x/foo", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "host" });
    expect(invokeCalls).toHaveLength(1);
    expect(invokeCalls[0].params.method).toBe("GET");
    expect(invokeCalls[0].params.filePath.endsWith("foo.ts")).toBe(true);
    expect(invokeCalls[0].params.url).toContain("/v1/x/foo");
  });

  test("runs in-band when disabled (host never called)", async () => {
    writeHandler(
      "bar.ts",
      `export function GET() { return Response.json({ via: "in-band" }); }`,
    );
    hostEnabled = false;
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "bar",
      new Request("http://localhost/v1/x/bar", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "in-band" });
    expect(invokeCalls).toHaveLength(0);
  });

  test("forwards a POST body to the host", async () => {
    writeHandler(
      "echo.ts",
      `export function POST() { return new Response(); }`,
    );
    hostEnabled = true;
    invokeImpl = async (call) =>
      jsonResponse(201, {
        received: new TextDecoder().decode(call.body ?? new Uint8Array()),
      });
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "echo",
      new Request("http://localhost/v1/x/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      received: JSON.stringify({ hello: "world" }),
    });
  });

  test("maps a host timeout to 504", async () => {
    writeHandler("slow.ts", `export function GET() { return new Response(); }`);
    hostEnabled = true;
    invokeImpl = async () => {
      throw new FakeTimeoutError(1000);
    };
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "slow",
      new Request("http://localhost/v1/x/slow", { method: "GET" }),
    );
    expect(res.status).toBe(504);
  });

  test("maps host unavailable (incl. failed startup) to 503", async () => {
    writeHandler("down.ts", `export function GET() { return new Response(); }`);
    hostEnabled = true;
    invokeImpl = async () => {
      throw new FakeUnavailableError("route host failed to start");
    };
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "down",
      new Request("http://localhost/v1/x/down", { method: "GET" }),
    );
    expect(res.status).toBe(503);
  });

  test("drives the host client's timeout from the dispatcher's handler timeout", async () => {
    // The in-process and route-host paths must share one per-request deadline,
    // so the host client's hard-kill timeout is the dispatcher's, not the
    // client's own default.
    new UserRouteDispatcher({ context: context() });
    expect(ctorOptions.at(-1)?.invokeTimeoutMs).toBe(120_000);

    new UserRouteDispatcher({ context: context(), handlerTimeoutMs: 5_000 });
    expect(ctorOptions.at(-1)?.invokeTimeoutMs).toBe(5_000);
  });

  test("unknown route 404s without touching the host", async () => {
    hostEnabled = true;
    const dispatcher = makeDispatcher();

    const res = await dispatcher.dispatch(
      "does-not-exist",
      new Request("http://localhost/v1/x/does-not-exist", { method: "GET" }),
    );
    expect(res.status).toBe(404);
    expect(invokeCalls).toHaveLength(0);
  });
});
