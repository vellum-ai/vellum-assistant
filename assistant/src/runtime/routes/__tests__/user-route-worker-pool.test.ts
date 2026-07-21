import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getWorkspaceRoutesDir } from "../../../util/platform.js";
import type { UserRouteContext } from "../user-route-dispatcher.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";
import { UserRouteWorkerPool } from "../user-route-worker-pool.js";
import type { SerializedRequest } from "../user-route-worker-protocol.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let handlerDir: string;
const pools: UserRouteWorkerPool[] = [];

beforeEach(() => {
  handlerDir = mkdtempSync(join(tmpdir(), "user-route-pool-"));
});

afterEach(async () => {
  // Shut pools down first (terminates idle/active workers); poisoned
  // sync-stall workers were already removed from the pool and exit on their
  // own once their finite loop ends.
  await Promise.allSettled(pools.map((p) => p.shutdown()));
  pools.length = 0;
  rmSync(handlerDir, { recursive: true, force: true });
});

/** Track pools so they're always torn down. */
function makePool(
  overrides?: Partial<{
    context: UserRouteContext;
    maxWorkers: number;
    maxQueue: number;
    handlerTimeoutMs: number;
  }>,
): UserRouteWorkerPool {
  const pool = new UserRouteWorkerPool({
    context: overrides?.context ?? stubContext(),
    maxWorkers: overrides?.maxWorkers,
    maxQueue: overrides?.maxQueue,
    handlerTimeoutMs: overrides?.handlerTimeoutMs,
  });
  pools.push(pool);
  return pool;
}

interface StubContextSpies {
  published: unknown[];
  posts: Array<[string, string]>;
}

function stubContext(
  opts?: {
    postMessage?: (id: string, text: string) => Promise<{ messageId: string }>;
    publish?: (event: unknown) => Promise<void>;
  },
  spies?: StubContextSpies,
): UserRouteContext {
  return {
    assistantEventHub: {
      publish: async (event: unknown) => {
        spies?.published.push(event);
        await opts?.publish?.(event);
      },
    },
    conversations: {
      postMessage: async (id: string, text: string) => {
        spies?.posts.push([id, text]);
        return (
          (await opts?.postMessage?.(id, text)) ?? { messageId: "stub-msg" }
        );
      },
    },
    // Only `publish` is proxied to workers; cast the minimal stub to the type.
  } as unknown as UserRouteContext;
}

/** Write a handler file into the temp dir and return its absolute path + mtime. */
function writeHandlerFile(name: string, content: string): string {
  const path = join(handlerDir, name);
  writeFileSync(path, content);
  return path;
}

function serReq(
  method: string,
  init?: { url?: string; headers?: [string, string][]; body?: ArrayBuffer },
): SerializedRequest {
  return {
    url: init?.url ?? "http://localhost/v1/x/test",
    method,
    headers: init?.headers ?? [],
    body: init?.body ?? null,
  };
}

function jsonBody(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

function decodeJson(body: ArrayBuffer | null): unknown {
  if (!body) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

// ---------------------------------------------------------------------------
// Pool mechanics (direct)
// ---------------------------------------------------------------------------

describe("UserRouteWorkerPool — execution", () => {
  test("runs a handler on a worker and returns its response", async () => {
    const filePath = writeHandlerFile(
      "ok.ts",
      `export function GET() { return Response.json({ ok: true, where: "worker" }); }`,
    );
    const pool = makePool();

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "ok",
    });

    expect(res.status).toBe(200);
    expect(decodeJson(res.body)).toEqual({ ok: true, where: "worker" });
  });

  test("marshals a POST body across the worker boundary", async () => {
    const filePath = writeHandlerFile(
      "echo.ts",
      `export async function POST(req) {
        const body = await req.json();
        return Response.json({ echoed: body });
      }`,
    );
    const pool = makePool();

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "POST",
      request: serReq("POST", {
        headers: [["content-type", "application/json"]],
        body: jsonBody({ hello: "world" }),
      }),
      routePath: "echo",
    });

    expect(res.status).toBe(200);
    expect(decodeJson(res.body)).toEqual({ echoed: { hello: "world" } });
  });

  test("returns 405 with Allow when the method handler is missing", async () => {
    const filePath = writeHandlerFile(
      "post-only.ts",
      `export function POST() { return new Response("p"); }`,
    );
    const pool = makePool();

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "post-only",
    });

    expect(res.status).toBe(405);
    expect(res.headers).toContainEqual(["allow", "POST"]);
  });

  test("a handler that throws rejects run() (mapped to 500 by the caller)", async () => {
    const filePath = writeHandlerFile(
      "boom.ts",
      `export function GET() { throw new Error("boom in handler"); }`,
    );
    const pool = makePool();

    await expect(
      pool.run({
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
        method: "GET",
        request: serReq("GET"),
        routePath: "boom",
      }),
    ).rejects.toThrow("boom in handler");
  });
});

// ---------------------------------------------------------------------------
// The core claim: a synchronous stall does NOT block the main thread
// ---------------------------------------------------------------------------

describe("UserRouteWorkerPool — main-thread isolation", () => {
  test("a sync-stalling handler leaves the main thread and other workers live", async () => {
    // A fully synchronous busy-loop (never yields) that outlasts the timeout.
    const stallPath = writeHandlerFile(
      "stall.ts",
      `export function GET() {
        const start = Date.now();
        while (Date.now() - start < 2000) {}
        return new Response("late");
      }`,
    );
    const okPath = writeHandlerFile(
      "quick.ts",
      `export function GET() { return Response.json({ quick: true }); }`,
    );
    const pool = makePool({ maxWorkers: 2, handlerTimeoutMs: 400 });

    // Main-thread liveness probe: this interval can only tick if the main
    // event loop is NOT blocked while a worker sync-spins.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 50);

    const stall = pool.run({
      filePath: stallPath,
      mtimeMs: statSync(stallPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "stall",
    });

    // Fire a normal request on the second worker WHILE the first is stalling.
    const quickStart = Date.now();
    const quick = await pool.run({
      filePath: okPath,
      mtimeMs: statSync(okPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "quick",
    });
    const quickElapsed = Date.now() - quickStart;

    // The normal request completed promptly despite the ongoing sync stall.
    expect(quick.status).toBe(200);
    expect(decodeJson(quick.body)).toEqual({ quick: true });
    expect(quickElapsed).toBeLessThan(350);

    // The stalling request is answered with a 504 at the timeout.
    const stalled = await stall;
    clearInterval(timer);
    expect(stalled.status).toBe(504);

    // The main-thread timer kept firing throughout — the daemon never froze.
    expect(ticks).toBeGreaterThan(3);
  });

  test("after a timeout the pool replaces the worker and keeps serving", async () => {
    const stallPath = writeHandlerFile(
      "stall2.ts",
      `export function GET() {
        const start = Date.now();
        while (Date.now() - start < 1500) {}
        return new Response("late");
      }`,
    );
    const okPath = writeHandlerFile(
      "ok2.ts",
      `export function GET() { return Response.json({ served: true }); }`,
    );
    // Single worker so the replacement path is exercised, not a spare worker.
    const pool = makePool({ maxWorkers: 1, handlerTimeoutMs: 300 });

    const stalled = await pool.run({
      filePath: stallPath,
      mtimeMs: statSync(stallPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "stall2",
    });
    expect(stalled.status).toBe(504);

    // The only worker was poisoned; a fresh one must spawn for the next request.
    const after = await pool.run({
      filePath: okPath,
      mtimeMs: statSync(okPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "ok2",
    });
    expect(after.status).toBe(200);
    expect(decodeJson(after.body)).toEqual({ served: true });
  });

  test("saturated pool + queue returns 503 rather than growing unbounded", async () => {
    const stallPath = writeHandlerFile(
      "stall3.ts",
      `export function GET() {
        const start = Date.now();
        while (Date.now() - start < 1500) {}
        return new Response("late");
      }`,
    );
    // One worker, zero queue slots: a second concurrent request has nowhere to go.
    const pool = makePool({
      maxWorkers: 1,
      maxQueue: 0,
      handlerTimeoutMs: 800,
    });

    const first = pool.run({
      filePath: stallPath,
      mtimeMs: statSync(stallPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "stall3",
    });

    // Give the first request a moment to occupy the single worker.
    await new Promise((r) => setTimeout(r, 50));

    const second = await pool.run({
      filePath: stallPath,
      mtimeMs: statSync(stallPath).mtimeMs,
      method: "GET",
      request: serReq("GET"),
      routePath: "stall3",
    });
    expect(second.status).toBe(503);

    // First eventually times out (504); await it so teardown is clean.
    expect((await first).status).toBe(504);
  });
});

// ---------------------------------------------------------------------------
// Context RPC — handler → main thread singletons
// ---------------------------------------------------------------------------

describe("UserRouteWorkerPool — context RPC", () => {
  test("publish reaches the injected event hub", async () => {
    const spies: StubContextSpies = { published: [], posts: [] };
    const filePath = writeHandlerFile(
      "publish.ts",
      `export async function POST(req, ctx) {
        await ctx.assistantEventHub.publish({
          id: "evt-1",
          assistantId: "self",
          conversationId: "conv-1",
          emittedAt: "t",
          message: { type: "open_conversation", conversationId: "conv-1" },
        });
        return Response.json({ published: true });
      }`,
    );
    const pool = makePool({ context: stubContext(undefined, spies) });

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "POST",
      request: serReq("POST"),
      routePath: "publish",
    });

    expect(res.status).toBe(200);
    expect(decodeJson(res.body)).toEqual({ published: true });
    expect(spies.published).toHaveLength(1);
    expect(
      (spies.published[0] as { conversationId: string }).conversationId,
    ).toBe("conv-1");
  });

  test("postMessage round-trips its return value back to the handler", async () => {
    const spies: StubContextSpies = { published: [], posts: [] };
    const filePath = writeHandlerFile(
      "postmsg.ts",
      `export async function POST(req, ctx) {
        const result = await ctx.conversations.postMessage("conv-9", "hi there");
        return Response.json(result);
      }`,
    );
    const pool = makePool({
      context: stubContext(
        { postMessage: async () => ({ messageId: "msg-42" }) },
        spies,
      ),
    });

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "POST",
      request: serReq("POST"),
      routePath: "postmsg",
    });

    expect(res.status).toBe(200);
    expect(decodeJson(res.body)).toEqual({ messageId: "msg-42" });
    expect(spies.posts).toEqual([["conv-9", "hi there"]]);
  });

  test("a context error propagates with its code so handlers can branch", async () => {
    const filePath = writeHandlerFile(
      "postmsg-err.ts",
      `export async function POST(req, ctx) {
        try {
          await ctx.conversations.postMessage("missing", "x");
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ code: err.code }, { status: 400 });
        }
      }`,
    );
    const pool = makePool({
      context: stubContext({
        postMessage: async () => {
          throw Object.assign(new Error("conversation not found"), {
            code: "not_found",
          });
        },
      }),
    });

    const res = await pool.run({
      filePath,
      mtimeMs: statSync(filePath).mtimeMs,
      method: "POST",
      request: serReq("POST"),
      routePath: "postmsg-err",
    });

    expect(res.status).toBe(400);
    expect(decodeJson(res.body)).toEqual({ code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the dispatcher (resolution + marshaling + Response rebuild)
// ---------------------------------------------------------------------------

describe("UserRouteDispatcher — with worker pool", () => {
  function writeWorkspaceHandler(relativePath: string, content: string): void {
    const full = join(getWorkspaceRoutesDir(), relativePath);
    mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }

  function makeDispatcher(handlerTimeoutMs?: number): UserRouteDispatcher {
    const context = stubContext();
    const pool = new UserRouteWorkerPool({ context, handlerTimeoutMs });
    pools.push(pool);
    return new UserRouteDispatcher({ context, pool });
  }

  test("dispatches a GET end-to-end through a worker", async () => {
    writeWorkspaceHandler(
      "status.ts",
      `export function GET() { return Response.json({ status: "ok" }); }`,
    );
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "status",
      new Request("http://localhost/v1/x/status", { method: "GET" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("round-trips a POST body and status through the worker", async () => {
    writeWorkspaceHandler(
      "create.ts",
      `export async function POST(req) {
        const body = await req.json();
        return Response.json({ created: body.name }, { status: 201 });
      }`,
    );
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "create",
      new Request("http://localhost/v1/x/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: "widget" });
  });

  test("unknown route still 404s without touching a worker", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "does-not-exist",
      new Request("http://localhost/v1/x/does-not-exist", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });

  test("a synchronous stall surfaces as a 504 to the client", async () => {
    writeWorkspaceHandler(
      "hang.ts",
      `export function GET() {
        const start = Date.now();
        while (Date.now() - start < 1500) {}
        return new Response("late");
      }`,
    );
    const dispatcher = makeDispatcher(300);
    const res = await dispatcher.dispatch(
      "hang",
      new Request("http://localhost/v1/x/hang", { method: "GET" }),
    );
    expect(res.status).toBe(504);
  });
});
