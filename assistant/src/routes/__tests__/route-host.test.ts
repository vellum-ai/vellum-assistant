import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { getProcPidPath, getProcSocketPath } from "../../util/platform.js";
import {
  RouteHostClient,
  RouteHostTimeoutError,
} from "../route-host-client.js";
import { ROUTE_HOST_PROC_NAME } from "../route-host-protocol.js";

// The route host is a real subprocess keyed by a PID file under the (per-test-
// process temp) workspace, so a single client is shared across the file; the
// stall test kills the host and the next invoke transparently respawns it.
let client: RouteHostClient;
let handlerDir: string;

const PLUGIN_API_MODULE_URL = new URL(
  "../../plugin-api/index.ts",
  import.meta.url,
).href;

beforeAll(() => {
  handlerDir = mkdtempSync(join(tmpdir(), "route-host-"));
  client = new RouteHostClient({ invokeTimeoutMs: 1000 });
});

afterAll(() => {
  client.dispose();
  cleanProcFiles();
  rmSync(handlerDir, { recursive: true, force: true });
});

afterEach(() => {
  // Nothing per-test: the shared host is reused (auto-respawned after a kill).
});

function cleanProcFiles(): void {
  for (const p of [
    getProcSocketPath(ROUTE_HOST_PROC_NAME),
    getProcPidPath(ROUTE_HOST_PROC_NAME),
  ]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }
}

function writeHandler(name: string, content: string): { filePath: string } {
  const filePath = join(handlerDir, name);
  writeFileSync(filePath, content);
  return { filePath };
}

function url(name: string): string {
  return `http://localhost/v1/x/${name}`;
}

function decode(body: Uint8Array | null): unknown {
  if (!body) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

describe("route host subprocess", () => {
  test("runs a GET handler in the subprocess and returns its response", async () => {
    const { filePath } = writeHandler(
      "ok.ts",
      `export function GET() { return Response.json({ ok: true, pid: process.pid }); }`,
    );
    const res = await client.invoke(
      { filePath, method: "GET", url: url("ok"), headers: [] },
      { body: null },
    );
    expect(res.status).toBe(200);
    const body = decode(res.body) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    // The handler ran in a different process than this test.
    expect(body.pid).not.toBe(process.pid);
  });

  test("round-trips a POST body through the subprocess", async () => {
    const { filePath } = writeHandler(
      "echo.ts",
      `export async function POST(req) {
        const body = await req.json();
        return Response.json({ echoed: body }, { status: 201 });
      }`,
    );
    const payload = new TextEncoder().encode(
      JSON.stringify({ hello: "world" }),
    );
    const res = await client.invoke(
      {
        filePath,
        method: "POST",
        url: url("echo"),
        headers: [["content-type", "application/json"]],
      },
      { body: payload },
    );
    expect(res.status).toBe(201);
    expect(decode(res.body)).toEqual({ echoed: { hello: "world" } });
  });

  test("returns 405 with Allow when the method handler is missing", async () => {
    const { filePath } = writeHandler(
      "post-only.ts",
      `export function POST() { return new Response("p"); }`,
    );
    const res = await client.invoke(
      { filePath, method: "GET", url: url("post-only"), headers: [] },
      { body: null },
    );
    expect(res.status).toBe(405);
    expect(res.headers).toContainEqual(["allow", "POST"]);
  });

  test("a handler that throws rejects the invocation", async () => {
    const { filePath } = writeHandler(
      "boom.ts",
      `export function GET() { throw new Error("boom in handler"); }`,
    );
    await expect(
      client.invoke(
        { filePath, method: "GET", url: url("boom"), headers: [] },
        { body: null },
      ),
    ).rejects.toThrow("boom in handler");
  });

  test("carries plugin context and brokers an approved host call", async () => {
    const { filePath } = writeHandler(
      "context.ts",
      `import { requirePluginRouteContext } from ${JSON.stringify(PLUGIN_API_MODULE_URL)};
       export async function GET() {
         const context = requirePluginRouteContext();
         const storageDir = await context.host.getPluginStorageDir();
         return Response.json({
           pluginId: context.pluginId,
           principalId: context.actor.principalId,
           requestId: context.requestId,
           hasSignal: context.signal instanceof AbortSignal,
           storageDir,
         });
       }`,
    );
    const pluginStorageDir = join(handlerDir, "plugin-data");
    const res = await client.invoke(
      {
        filePath,
        method: "GET",
        url: url("context"),
        headers: [],
        pluginContext: {
          pluginId: "example-plugin",
          actor: {
            principalType: "actor",
            principalId: "user-123",
            scopes: ["settings.read"],
          },
          requestId: "request-123",
          verifiedPeer: null,
        },
      },
      {
        body: null,
        brokerContext: {
          pluginId: "example-plugin",
          pluginStorageDir,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(decode(res.body)).toEqual({
      pluginId: "example-plugin",
      principalId: "user-123",
      requestId: "request-123",
      hasSignal: true,
      storageDir: pluginStorageDir,
    });
  });

  test("blocks direct conversation-store access in the route host", async () => {
    const { filePath } = writeHandler(
      "conversation-store.ts",
      `import { getMessages } from ${JSON.stringify(PLUGIN_API_MODULE_URL)};
       export async function GET() {
         await getMessages("conv-xyz");
         return new Response("unexpected");
       }`,
    );

    await expect(
      client.invoke(
        {
          filePath,
          method: "GET",
          url: url("conversation-store"),
          headers: [],
        },
        { body: null },
      ),
    ).rejects.toThrow("Conversation store access is unavailable");
  });

  test("propagates caller abort to the handler without waiting for timeout", async () => {
    const abortMarker = join(handlerDir, "request-aborted");
    const { filePath } = writeHandler(
      "abort.ts",
      `import { writeFileSync } from "node:fs";
       import { requirePluginRouteContext } from ${JSON.stringify(PLUGIN_API_MODULE_URL)};
       export function GET(request) {
         return new Promise((resolve) => {
           const onAbort = async () => {
             const context = requirePluginRouteContext();
             try {
               await context.host.getPluginStorageDir();
               writeFileSync(${JSON.stringify(abortMarker)}, "broker allowed");
             } catch (error) {
               writeFileSync(${JSON.stringify(abortMarker)}, error.message);
             }
             resolve(new Response("aborted"));
           };
           if (request.signal.aborted) {
             onAbort();
             return;
           }
           request.signal.addEventListener("abort", onAbort, { once: true });
         });
       }`,
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const invocation = client.invoke(
      {
        filePath,
        method: "GET",
        url: url("abort"),
        headers: [],
        pluginContext: {
          pluginId: "example-plugin",
          actor: {
            principalType: "actor",
            principalId: "user-123",
            scopes: ["settings.read"],
          },
          requestId: "request-abort",
          verifiedPeer: null,
        },
      },
      {
        body: null,
        signal: controller.signal,
        brokerContext: {
          pluginId: "example-plugin",
          pluginStorageDir: join(handlerDir, "plugin-data"),
        },
      },
    );

    controller.abort();

    await expect(invocation).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    for (let attempt = 0; attempt < 50 && !existsSync(abortMarker); attempt++) {
      await Bun.sleep(10);
    }
    expect(existsSync(abortMarker)).toBe(true);
    expect(readFileSync(abortMarker, "utf8")).toBe(
      "broker request rejected after invocation abort",
    );
  });

  test("a synchronous stall is hard-killed on timeout, and the host recovers", async () => {
    const stall = writeHandler(
      "stall.ts",
      `export function GET() {
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        return new Response("late");
      }`,
    );
    const ok = writeHandler(
      "after.ts",
      `export function GET() { return Response.json({ recovered: true }); }`,
    );

    // Main-process liveness: this interval keeps ticking only because the stall
    // runs in a *different* process — the daemon is never blocked.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 50);

    await expect(
      client.invoke(
        {
          filePath: stall.filePath,
          method: "GET",
          url: url("stall"),
          headers: [],
        },
        { body: null },
      ),
    ).rejects.toBeInstanceOf(RouteHostTimeoutError);

    clearInterval(timer);
    // ~1000ms timeout at 50ms cadence → the main loop stayed live throughout.
    expect(ticks).toBeGreaterThan(3);

    // The host was SIGKILL'd; the next invocation must transparently respawn it.
    const res = await client.invoke(
      {
        filePath: ok.filePath,
        method: "GET",
        url: url("after"),
        headers: [],
      },
      { body: null },
    );
    expect(res.status).toBe(200);
    expect(decode(res.body)).toEqual({ recovered: true });
  });
});
