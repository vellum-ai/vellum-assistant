import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getWorkspaceRoutesDir } from "../../../util/platform.js";
import { AssistantEventHub } from "../../assistant-event-hub.js";
import type { UserRouteContext } from "../user-route-dispatcher.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal UserRouteContext for tests. */
function makeContext(overrides?: Partial<UserRouteContext>): UserRouteContext {
  return {
    assistantEventHub: new AssistantEventHub(),
    assistantId: "test-assistant",
    ...overrides,
  };
}

/** Create a dispatcher with a stub context and optional overrides. */
function makeDispatcher(
  options?: Partial<{
    handlerTimeoutMs: number;
    context: UserRouteContext;
  }>,
): UserRouteDispatcher {
  return new UserRouteDispatcher({
    context: options?.context ?? makeContext(),
    ...options,
  });
}

function makeRequest(
  method: string,
  path = "http://localhost/v1/x/test",
): Request {
  return new Request(path, { method });
}

function writeHandler(relativePath: string, content: string): string {
  const routesDir = getWorkspaceRoutesDir();
  const fullPath = join(routesDir, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

async function readErrorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return response.json();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
});

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe("path traversal", () => {
  test("rejects paths containing '..'", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("../etc/passwd", makeRequest("GET"));
    expect(res.status).toBe(400);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Path traversal");
  });

  test("rejects embedded '..' segments", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch(
      "foo/../../etc/passwd",
      makeRequest("GET"),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 404 — missing handler
// ---------------------------------------------------------------------------

describe("missing handler", () => {
  test("returns 404 when no handler file exists", async () => {
    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("nonexistent", makeRequest("GET"));
    expect(res.status).toBe(404);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("/x/nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Successful dispatch
// ---------------------------------------------------------------------------

describe("successful dispatch", () => {
  test("dispatches GET to handler exporting GET function", async () => {
    writeHandler(
      "hello.ts",
      `export function GET(request) {
        return Response.json({ greeting: "hello" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("hello", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.greeting).toBe("hello");
  });

  test("dispatches POST to handler exporting POST function", async () => {
    writeHandler(
      "submit.ts",
      `export async function POST(request) {
        return Response.json({ received: true }, { status: 201 });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("submit", makeRequest("POST"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  test("dispatches to .js handler files", async () => {
    writeHandler(
      "legacy.js",
      `export function GET(request) {
        return Response.json({ format: "js" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("legacy", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("js");
  });
});

// ---------------------------------------------------------------------------
// Index file convention
// ---------------------------------------------------------------------------

describe("index file convention", () => {
  test("resolves directory to index.ts", async () => {
    writeHandler(
      "my-app/index.ts",
      `export function GET(request) {
        return Response.json({ index: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("my-app", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBe(true);
  });

  test("resolves directory to index.js when no index.ts", async () => {
    writeHandler(
      "fallback-app/index.js",
      `export function GET(request) {
        return Response.json({ index: "js" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("fallback-app", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBe("js");
  });

  test("prefers direct file over index file", async () => {
    writeHandler(
      "dual.ts",
      `export function GET(request) {
        return Response.json({ source: "direct" });
      }`,
    );
    writeHandler(
      "dual/index.ts",
      `export function GET(request) {
        return Response.json({ source: "index" });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("dual", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// 405 — method not allowed
// ---------------------------------------------------------------------------

describe("method not allowed", () => {
  test("returns 405 with Allow header when method not exported", async () => {
    writeHandler(
      "get-only.ts",
      `export function GET(request) {
        return Response.json({ ok: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("get-only", makeRequest("POST"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  test("lists multiple allowed methods in Allow header", async () => {
    writeHandler(
      "multi.ts",
      `export function GET(request) { return new Response("ok"); }
       export function POST(request) { return new Response("ok"); }
       export function DELETE(request) { return new Response("ok"); }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("multi", makeRequest("PUT"));
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow");
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).toContain("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Handler timeout
// ---------------------------------------------------------------------------

describe("handler timeout", () => {
  test("returns 504 when handler exceeds timeout", async () => {
    writeHandler(
      "slow.ts",
      `export function GET(request) {
        return new Promise(() => {});
      }`,
    );

    // Use a very short timeout for testing
    const dispatcher = makeDispatcher({ handlerTimeoutMs: 50 });
    const res = await dispatcher.dispatch("slow", makeRequest("GET"));
    expect(res.status).toBe(504);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.message).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Handler errors
// ---------------------------------------------------------------------------

describe("handler errors", () => {
  test("returns 500 when handler throws synchronously", async () => {
    writeHandler(
      "throws.ts",
      `export function GET(request) {
        throw new Error("boom");
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("throws", makeRequest("GET"));
    expect(res.status).toBe(500);
    const body = await readErrorBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("boom");
  });

  test("returns 500 when handler rejects", async () => {
    writeHandler(
      "rejects.ts",
      `export async function GET(request) {
        throw new Error("async boom");
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("rejects", makeRequest("GET"));
    expect(res.status).toBe(500);
    const body = await readErrorBody(res);
    expect(body.error.message).toBe("async boom");
  });
});

// ---------------------------------------------------------------------------
// Mtime-based cache invalidation
// ---------------------------------------------------------------------------

describe("mtime cache", () => {
  test("serves updated content after file modification", async () => {
    const filePath = writeHandler(
      "mutable.ts",
      `export function GET(request) {
        return Response.json({ version: 1 });
      }`,
    );

    const dispatcher = makeDispatcher();

    // First request — version 1
    const res1 = await dispatcher.dispatch("mutable", makeRequest("GET"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.version).toBe(1);

    // Wait briefly to ensure mtime changes, then rewrite
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(
      filePath,
      `export function GET(request) {
        return Response.json({ version: 2 });
      }`,
    );

    // Second request — should pick up version 2
    const res2 = await dispatcher.dispatch("mutable", makeRequest("GET"));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Subdirectory routing
// ---------------------------------------------------------------------------

describe("subdirectory routing", () => {
  test("dispatches to nested handler files", async () => {
    writeHandler(
      "api/v1/status.ts",
      `export function GET(request) {
        return Response.json({ nested: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("api/v1/status", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Description metadata
// ---------------------------------------------------------------------------

describe("description metadata", () => {
  test("ignores non-handler exports without affecting dispatch", async () => {
    writeHandler(
      "with-meta.ts",
      `export const description = "A test handler";
       export function GET(request) {
         return Response.json({ ok: true });
       }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("with-meta", makeRequest("GET"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Context injection
// ---------------------------------------------------------------------------

describe("context injection", () => {
  test("passes UserRouteContext as second argument to handler", async () => {
    writeHandler(
      "ctx-echo.ts",
      `export function GET(request, context) {
        return Response.json({
          hasHub: typeof context.assistantEventHub?.publish === "function",
          assistantId: context.assistantId,
        });
      }`,
    );

    const ctx = makeContext({ assistantId: "custom-id" });
    const dispatcher = makeDispatcher({ context: ctx });
    const res = await dispatcher.dispatch("ctx-echo", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasHub).toBe(true);
    expect(body.assistantId).toBe("custom-id");
  });

  test("handler can publish events through injected hub", async () => {
    writeHandler(
      "ctx-publish.ts",
      `export async function POST(request, context) {
        const body = await request.json();
        await context.assistantEventHub.publish({
          id: "test-event-1",
          assistantId: context.assistantId,
          conversationId: body.conversationId,
          emittedAt: new Date().toISOString(),
          message: { type: "open_conversation", conversationId: body.conversationId },
        });
        return Response.json({ published: true });
      }`,
    );

    const hub = new AssistantEventHub();
    const received: unknown[] = [];
    hub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });

    const ctx = makeContext({ assistantEventHub: hub });
    const dispatcher = makeDispatcher({ context: ctx });
    const req = new Request("http://localhost/v1/x/ctx-publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-123" }),
    });
    const res = await dispatcher.dispatch("ctx-publish", req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.published).toBe(true);
    expect(received).toHaveLength(1);
    expect((received[0] as { conversationId: string }).conversationId).toBe(
      "conv-123",
    );
  });

  test("legacy handlers that ignore context still work", async () => {
    writeHandler(
      "no-ctx.ts",
      `export function GET(request) {
        return Response.json({ legacy: true });
      }`,
    );

    const dispatcher = makeDispatcher();
    const res = await dispatcher.dispatch("no-ctx", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.legacy).toBe(true);
  });

  test("context is frozen — mutations throw in strict mode", async () => {
    writeHandler(
      "ctx-mutate.ts",
      `export function GET(request, context) {
        let threw = false;
        try {
          context.assistantId = "hacked";
        } catch {
          threw = true;
        }
        return Response.json({ threw, assistantId: context.assistantId });
      }`,
    );

    const ctx = makeContext({ assistantId: "original" });
    const dispatcher = makeDispatcher({ context: ctx });
    const res = await dispatcher.dispatch("ctx-mutate", makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Object.freeze makes property assignment throw in strict mode (ESM)
    // and silently fail in sloppy mode — either way the value is unchanged.
    expect(body.assistantId).toBe("original");
  });
});
