import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
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

function writeHandler(
  name: string,
  content: string,
): { filePath: string; mtimeMs: number } {
  const filePath = join(handlerDir, name);
  writeFileSync(filePath, content);
  return { filePath, mtimeMs: statSync(filePath).mtimeMs };
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
    const { filePath, mtimeMs } = writeHandler(
      "ok.ts",
      `export function GET() { return Response.json({ ok: true, pid: process.pid }); }`,
    );
    const res = await client.invoke(
      { filePath, mtimeMs, method: "GET", url: url("ok"), headers: [] },
      null,
    );
    expect(res.status).toBe(200);
    const body = decode(res.body) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    // The handler ran in a different process than this test.
    expect(body.pid).not.toBe(process.pid);
  });

  test("round-trips a POST body through the subprocess", async () => {
    const { filePath, mtimeMs } = writeHandler(
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
        mtimeMs,
        method: "POST",
        url: url("echo"),
        headers: [["content-type", "application/json"]],
      },
      payload,
    );
    expect(res.status).toBe(201);
    expect(decode(res.body)).toEqual({ echoed: { hello: "world" } });
  });

  test("returns 405 with Allow when the method handler is missing", async () => {
    const { filePath, mtimeMs } = writeHandler(
      "post-only.ts",
      `export function POST() { return new Response("p"); }`,
    );
    const res = await client.invoke(
      { filePath, mtimeMs, method: "GET", url: url("post-only"), headers: [] },
      null,
    );
    expect(res.status).toBe(405);
    expect(res.headers).toContainEqual(["allow", "POST"]);
  });

  test("a handler that throws rejects the invocation", async () => {
    const { filePath, mtimeMs } = writeHandler(
      "boom.ts",
      `export function GET() { throw new Error("boom in handler"); }`,
    );
    await expect(
      client.invoke(
        { filePath, mtimeMs, method: "GET", url: url("boom"), headers: [] },
        null,
      ),
    ).rejects.toThrow("boom in handler");
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
          mtimeMs: stall.mtimeMs,
          method: "GET",
          url: url("stall"),
          headers: [],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(RouteHostTimeoutError);

    clearInterval(timer);
    // ~1000ms timeout at 50ms cadence → the main loop stayed live throughout.
    expect(ticks).toBeGreaterThan(3);

    // The host was SIGKILL'd; the next invocation must transparently respawn it.
    const res = await client.invoke(
      {
        filePath: ok.filePath,
        mtimeMs: ok.mtimeMs,
        method: "GET",
        url: url("after"),
        headers: [],
      },
      null,
    );
    expect(res.status).toBe(200);
    expect(decode(res.body)).toEqual({ recovered: true });
  });
});
