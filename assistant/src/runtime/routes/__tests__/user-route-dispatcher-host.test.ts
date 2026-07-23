import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  RouteHostClient,
  RouteInvokeResponse,
} from "../../../routes/route-host-client.js";
import {
  RouteHostTimeoutError,
  RouteHostUnavailableError,
} from "../../../routes/route-host-client.js";
import type { RouteInvokeParams } from "../../../routes/route-host-protocol.js";
import { getWorkspaceRoutesDir } from "../../../util/platform.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import type {
  RouteHostBinding,
  UserRouteContext,
} from "../user-route-dispatcher.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";

function context(): UserRouteContext {
  return {
    assistantEventHub: new AssistantEventHub(),
    conversations: { postMessage: async () => ({ messageId: "m" }) },
  };
}

function writeHandler(name: string, content: string): void {
  const full = join(getWorkspaceRoutesDir(), name);
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
});

interface InvokeCall {
  params: RouteInvokeParams;
  body: Uint8Array | null;
}

/** A fake RouteHostClient recording invocations, with a scriptable reply. */
function fakeHost(reply: (call: InvokeCall) => Promise<RouteInvokeResponse>): {
  binding: (enabled: boolean) => RouteHostBinding;
  calls: InvokeCall[];
} {
  const calls: InvokeCall[] = [];
  const client = {
    invoke: async (params: RouteInvokeParams, body: Uint8Array | null) => {
      const call = { params, body };
      calls.push(call);
      return reply(call);
    },
  } as unknown as RouteHostClient;
  return {
    calls,
    binding: (enabled: boolean) => ({ client, isEnabled: () => enabled }),
  };
}

function jsonResponse(status: number, value: unknown): RouteInvokeResponse {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe("UserRouteDispatcher — route host delegation", () => {
  test("delegates to the host when enabled (in-band handler never runs)", async () => {
    // If the in-band path ran, it would return {via:"in-band"}; the host reply
    // returns {via:"host"}, so the response distinguishes which path executed.
    writeHandler(
      "foo.ts",
      `export function GET() { return Response.json({ via: "in-band" }); }`,
    );
    const host = fakeHost(async () => jsonResponse(200, { via: "host" }));
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(true),
    });

    const res = await dispatcher.dispatch(
      "foo",
      new Request("http://localhost/v1/x/foo", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "host" });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].params.method).toBe("GET");
    expect(host.calls[0].params.filePath.endsWith("foo.ts")).toBe(true);
    expect(host.calls[0].params.url).toContain("/v1/x/foo");
  });

  test("runs in-band when disabled (host never called)", async () => {
    writeHandler(
      "bar.ts",
      `export function GET() { return Response.json({ via: "in-band" }); }`,
    );
    const host = fakeHost(async () => jsonResponse(200, { via: "host" }));
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(false),
    });

    const res = await dispatcher.dispatch(
      "bar",
      new Request("http://localhost/v1/x/bar", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "in-band" });
    expect(host.calls).toHaveLength(0);
  });

  test("forwards a POST body to the host", async () => {
    writeHandler(
      "echo.ts",
      `export function POST() { return new Response(); }`,
    );
    const host = fakeHost(async (call) =>
      jsonResponse(201, {
        received: new TextDecoder().decode(call.body ?? new Uint8Array()),
      }),
    );
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(true),
    });

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
    const host = fakeHost(async () => {
      throw new RouteHostTimeoutError(1000);
    });
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(true),
    });

    const res = await dispatcher.dispatch(
      "slow",
      new Request("http://localhost/v1/x/slow", { method: "GET" }),
    );
    expect(res.status).toBe(504);
  });

  test("maps host unavailable to 503", async () => {
    writeHandler("down.ts", `export function GET() { return new Response(); }`);
    const host = fakeHost(async () => {
      throw new RouteHostUnavailableError("route host killed");
    });
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(true),
    });

    const res = await dispatcher.dispatch(
      "down",
      new Request("http://localhost/v1/x/down", { method: "GET" }),
    );
    expect(res.status).toBe(503);
  });

  test("unknown route 404s without touching the host", async () => {
    const host = fakeHost(async () => jsonResponse(200, {}));
    const dispatcher = new UserRouteDispatcher({
      context: context(),
      routeHost: host.binding(true),
    });

    const res = await dispatcher.dispatch(
      "does-not-exist",
      new Request("http://localhost/v1/x/does-not-exist", { method: "GET" }),
    );
    expect(res.status).toBe(404);
    expect(host.calls).toHaveLength(0);
  });
});
