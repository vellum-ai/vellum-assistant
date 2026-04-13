/**
 * Subprocess regression tests for the Chrome native messaging helper.
 *
 * These tests spawn the compiled helper binary and verify:
 *
 *   1. Unauthorized chrome-extension origins terminate with exit code 1
 *      BEFORE any HTTP request is made to /v1/browser-extension-pair.
 *      (The helper installs its stdin listener only after the origin
 *      allowlist check, so unauthorized callers cannot inject frames.)
 *
 *   2. Authorized origins forward the pair endpoint's token, expiresAt,
 *      and guardianId fields verbatim into the native-messaging
 *      token_response frame.
 *
 *   3. A pair endpoint response missing guardianId causes the helper to
 *      exit non-zero and emit an error frame, preventing a malformed
 *      token from reaching the extension's bootstrap path.
 *
 *   4. `list_assistants` frames return the lockfile assistant inventory.
 *
 *   5. `request_token` frames with `assistantId` resolve the daemon port
 *      from the lockfile and target the correct assistant.
 *
 * The suite skips gracefully when `dist/index.js` is missing so cold
 * checkouts don't break CI.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { decodeFrames, encodeFrame } from "../protocol.js";

// ---------------------------------------------------------------------------
// Paths & skip guard
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELPER_BINARY = resolve(__dirname, "../../dist/index.js");
const HELPER_EXISTS = existsSync(HELPER_BINARY);
const REPO_ROOT = resolve(__dirname, "../../../../../");

const SKIP_REASON =
  "clients/chrome-extension/native-host/dist/index.js is missing — run `bun run build` in clients/chrome-extension/native-host to enable these tests.";

function getAllowedOriginFromCanonicalConfig(): string {
  const raw = readFileSync(
    resolve(
      REPO_ROOT,
      "meta/browser-extension/chrome-extension-allowlist.json",
    ),
    "utf8",
  );
  const parsed = JSON.parse(raw) as {
    allowedExtensionIds?: string[];
  };
  const firstId = parsed.allowedExtensionIds?.[0];
  if (!firstId) {
    throw new Error(
      "chrome-extension-allowlist.json must include at least one extension id for tests",
    );
  }
  return `chrome-extension://${firstId}/`;
}

const ALLOWED_ORIGIN = getAllowedOriginFromCanonicalConfig();
const DISALLOWED_ORIGIN =
  "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/";

// ---------------------------------------------------------------------------
// Mock pair-endpoint server
// ---------------------------------------------------------------------------

interface MockPairServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  /** All requests received by the mock server, in order. */
  requests: Array<{
    pathname: string;
    body: unknown;
    headers: Record<string, string>;
  }>;
  /** Body the next pair request should return. */
  nextResponseBody: () => Record<string, unknown>;
  stop: () => void;
}

/**
 * Boot a tiny `Bun.serve` listener on a free port that records every
 * request and responds with whatever `nextResponseBody` produces. The
 * test can mutate `nextResponseBody` between scenarios to swap fixtures
 * (e.g. drop `guardianId` from the response to exercise the
 * malformed-frame rejection path).
 */
function startMockPairServer(): MockPairServer {
  const state: MockPairServer = {
    server: null as unknown as ReturnType<typeof Bun.serve>,
    port: 0,
    requests: [],
    nextResponseBody: () => ({
      token: "tok-1",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-1",
    }),
    stop: () => {
      /* replaced below */
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      // Snapshot the headers as a plain object so the assertion
      // surface stays stable across Headers iteration quirks.
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      state.requests.push({ pathname: url.pathname, body, headers });

      if (
        url.pathname !== "/v1/browser-extension-pair" ||
        req.method !== "POST"
      ) {
        return new Response("not found", { status: 404 });
      }

      return Response.json(state.nextResponseBody());
    },
  });

  state.server = server;
  state.port = server.port as number;
  state.stop = () => server.stop(true);
  return state;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface HelperRunResult {
  frames: unknown[];
  stderr: string;
  exitCode: number;
}

/**
 * Spawn the helper as a subprocess via `Bun.spawn`, write the framed
 * `request_token` payload to its stdin, and collect stdout / stderr /
 * exit code with a hard upper bound on wall-clock time. Uses
 * `Bun.spawn` (instead of `node:child_process`) for `proc.exited` as a
 * clean Promise that integrates with the bun:test runner.
 */
async function runHelper(options: {
  extensionOrigin: string;
  assistantPort?: number;
  stdinBytes: Buffer;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<HelperRunResult> {
  const args = [
    "node",
    HELPER_BINARY,
    options.extensionOrigin,
  ];
  if (options.assistantPort !== undefined) {
    args.push("--assistant-port", String(options.assistantPort));
  }

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });

  proc.stdin.write(options.stdinBytes);
  await proc.stdin.end();

  let timedOut = false;
  const timeoutMs = options.timeoutMs ?? 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdoutBuffer = Buffer.from(
    await new Response(proc.stdout).arrayBuffer(),
  );
  const stderrText = await new Response(proc.stderr).text();

  if (timedOut) {
    throw new Error(
      `helper binary did not exit within ${timeoutMs}ms — stderr: ${stderrText}`,
    );
  }

  let frames: unknown[];
  try {
    frames = decodeFrames(stdoutBuffer).frames;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to decode helper stdout frames: ${detail}; raw stderr: ${stderrText}`,
    );
  }

  return { frames, stderr: stderrText, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("native host — subprocess regression coverage", () => {
  let pair: MockPairServer | null = null;

  beforeAll(() => {
    if (!HELPER_EXISTS) return;
    pair = startMockPairServer();
    // Sanity-check the bound port so a wrong-port misconfig doesn't
    // silently masquerade as a network failure inside the helper.
    if (!pair.port) {
      throw new Error("mock pair server failed to bind");
    }
  });

  afterAll(() => {
    if (pair) pair.stop();
  });

  if (!HELPER_EXISTS) {
    test.skip(`native helper binary not built — ${SKIP_REASON}`, () => {
      /* intentionally empty */
    });
    return;
  }

  test("unauthorized origin halts before contacting the pair endpoint", async () => {
    const srv = pair!;
    srv.requests.length = 0;

    const result = await runHelper({
      extensionOrigin: DISALLOWED_ORIGIN,
      assistantPort: srv.port,
      // Pre-write a request_token frame so that if the unauthorized
      // branch ever falls through to the stdin listener, the helper
      // would observe a frame and POST the pair endpoint. Both of
      // those side effects are asserted below.
      stdinBytes: encodeFrame({ type: "request_token" }),
      timeoutMs: 1000,
    });

    // The helper must terminate with a non-zero exit code (we use the
    // documented value of 1) within the 1s timeout. If `runHelper`
    // throws on timeout, this assertion will not run.
    expect(result.exitCode).toBe(1);

    // Exactly one error frame on stdout — never a token_response.
    expect(result.frames).toHaveLength(1);
    const frame = result.frames[0] as { type?: unknown; message?: unknown; protocolVersion?: unknown };
    expect(frame.type).toBe("error");
    expect(frame.message).toBe("unauthorized_origin");
    // Error frames must include the protocol version so the extension
    // can detect incompatible native host versions even on error paths.
    expect(frame.protocolVersion).toBe(1);

    // The critical invariant: the helper must NOT have POSTed anything
    // to /v1/browser-extension-pair. If the unauthorized branch falls
    // through and the stdin listener runs, the mock server's
    // `requests` array will contain at least one entry.
    expect(srv.requests).toHaveLength(0);
  });

  test("authorized origin forwards guardianId in the token_response frame", async () => {
    const srv = pair!;
    srv.requests.length = 0;
    srv.nextResponseBody = () => ({
      token: "tok-1",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-1",
    });

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srv.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
      timeoutMs: 2000,
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as {
      type?: unknown;
      token?: unknown;
      expiresAt?: unknown;
      guardianId?: unknown;
      protocolVersion?: unknown;
    };
    expect(frame.type).toBe("token_response");
    expect(frame.token).toBe("tok-1");
    expect(frame.expiresAt).toBe("2026-12-31T00:00:00Z");
    expect(frame.guardianId).toBe("g-1");
    expect(frame.protocolVersion).toBe(1);

    // The helper should have made exactly one POST to the pair
    // endpoint, carrying the extension origin we passed on argv.
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.pathname).toBe("/v1/browser-extension-pair");
    expect(srv.requests[0]!.body).toEqual({ extensionOrigin: ALLOWED_ORIGIN });

    // PR4 of the browser-use remediation plan: the helper MUST set
    // the `x-vellum-native-host: 1` marker header on every pair
    // request. The assistant rejects pair requests that omit it, so
    // if this assertion fails the extension would stop pairing even
    // though the rest of the flow looks healthy.
    expect(srv.requests[0]!.headers["x-vellum-native-host"]).toBe("1");
  });

  test("native host helper sets the x-vellum-native-host marker header", async () => {
    // Dedicated regression test that pins down the marker-header
    // contract independent of the token/guardian assertions above.
    // If a future refactor accidentally drops the header, this test
    // fails in isolation rather than as a side effect of another
    // assertion.
    const srv = pair!;
    srv.requests.length = 0;
    srv.nextResponseBody = () => ({
      token: "marker-test-token",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "marker-g-1",
    });

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srv.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
      timeoutMs: 2000,
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.headers["x-vellum-native-host"]).toBe("1");
    expect(srv.requests[0]!.headers["content-type"]).toContain(
      "application/json",
    );
  });

  test("missing guardianId in the pair response is rejected with an error frame", async () => {
    const srv = pair!;
    srv.requests.length = 0;
    // Mock returns a body without `guardianId`. The helper's
    // request-token validation should catch the missing field and
    // surface an error frame instead of writing a malformed
    // token_response.
    srv.nextResponseBody = () => ({
      token: "tok-1",
      expiresAt: "2026-12-31T00:00:00Z",
    });

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srv.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
      timeoutMs: 2000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.frames).toHaveLength(1);
    const frame = result.frames[0] as { type?: unknown; message?: unknown; protocolVersion?: unknown };
    expect(frame.type).toBe("error");
    expect(typeof frame.message).toBe("string");
    expect(frame.message).toMatch(/guardianId/);
    expect(frame.protocolVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// list_assistants and assistant-scoped token request tests
// ---------------------------------------------------------------------------

describe("native host — list_assistants response framing", () => {
  let pair: MockPairServer | null = null;
  let lockfileDir: string;

  beforeAll(() => {
    if (!HELPER_EXISTS) return;
    pair = startMockPairServer();
  });

  afterAll(() => {
    if (pair) pair.stop();
  });

  beforeEach(() => {
    lockfileDir = mkdtempSync(join(tmpdir(), "native-host-lockfile-test-"));
  });

  afterEach(() => {
    try {
      rmSync(lockfileDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  if (!HELPER_EXISTS) {
    test.skip(`native helper binary not built — ${SKIP_REASON}`, () => {
      /* intentionally empty */
    });
    return;
  }

  test("list_assistants returns assistant inventory from lockfile", async () => {
    const lockfileData = {
      assistants: [
        {
          assistantId: "local-one",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 7821 },
        },
        {
          assistantId: "cloud-one",
          cloud: "vellum",
          runtimeUrl: "https://cloud.example.com",
        },
      ],
      activeAssistant: "local-one",
    };
    writeFileSync(
      join(lockfileDir, ".vellum.lock.json"),
      JSON.stringify(lockfileData),
    );

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: pair!.port,
      stdinBytes: encodeFrame({ type: "list_assistants" }),
      timeoutMs: 2000,
      env: { VELLUM_LOCKFILE_DIR: lockfileDir },
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as {
      type: string;
      assistants: Array<{
        assistantId: string;
        cloud: string;
        runtimeUrl: string;
        daemonPort: number | null;
        isActive: boolean;
      }>;
      activeAssistantId: string | null;
      protocolVersion: number;
    };

    expect(frame.type).toBe("assistants_response");
    expect(frame.activeAssistantId).toBe("local-one");
    expect(frame.protocolVersion).toBe(1);
    expect(frame.assistants).toHaveLength(2);

    expect(frame.assistants[0]!.assistantId).toBe("local-one");
    expect(frame.assistants[0]!.cloud).toBe("local");
    expect(frame.assistants[0]!.daemonPort).toBe(7821);
    expect(frame.assistants[0]!.isActive).toBe(true);

    expect(frame.assistants[1]!.assistantId).toBe("cloud-one");
    expect(frame.assistants[1]!.cloud).toBe("vellum");
    expect(frame.assistants[1]!.isActive).toBe(false);
  });

  test("list_assistants returns empty inventory when no lockfile exists", async () => {
    // Don't write any lockfile — the temp dir is empty.
    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: pair!.port,
      stdinBytes: encodeFrame({ type: "list_assistants" }),
      timeoutMs: 2000,
      env: { VELLUM_LOCKFILE_DIR: lockfileDir },
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as {
      type: string;
      assistants: unknown[];
      activeAssistantId: unknown;
      protocolVersion: unknown;
    };
    expect(frame.type).toBe("assistants_response");
    expect(frame.assistants).toEqual([]);
    expect(frame.activeAssistantId).toBeNull();
    expect(frame.protocolVersion).toBe(1);
  });
});

describe("native host — assistant-scoped token request", () => {
  let pairA: MockPairServer | null = null;
  let pairB: MockPairServer | null = null;
  let lockfileDir: string;

  beforeAll(() => {
    if (!HELPER_EXISTS) return;
    pairA = startMockPairServer();
    pairB = startMockPairServer();
  });

  afterAll(() => {
    if (pairA) pairA.stop();
    if (pairB) pairB.stop();
  });

  beforeEach(() => {
    lockfileDir = mkdtempSync(join(tmpdir(), "native-host-scoped-test-"));
  });

  afterEach(() => {
    try {
      rmSync(lockfileDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  if (!HELPER_EXISTS) {
    test.skip(`native helper binary not built — ${SKIP_REASON}`, () => {
      /* intentionally empty */
    });
    return;
  }

  test("request_token with assistantId uses the lockfile daemon port", async () => {
    const srvA = pairA!;
    const srvB = pairB!;
    srvA.requests.length = 0;
    srvB.requests.length = 0;

    srvA.nextResponseBody = () => ({
      token: "tok-a",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-a",
    });
    srvB.nextResponseBody = () => ({
      token: "tok-b",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-b",
    });

    // Write a lockfile where assistant-b's daemonPort points at srvB.
    const lockfileData = {
      assistants: [
        {
          assistantId: "assistant-a",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: srvA.port },
        },
        {
          assistantId: "assistant-b",
          cloud: "local",
          runtimeUrl: "http://localhost:7831",
          resources: { daemonPort: srvB.port },
        },
      ],
    };
    writeFileSync(
      join(lockfileDir, ".vellum.lock.json"),
      JSON.stringify(lockfileData),
    );

    // Request a token scoped to assistant-b. The helper should use
    // srvB's port (from the lockfile) rather than the --assistant-port
    // flag, which we intentionally set to srvA's port to prove the
    // lockfile takes precedence.
    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srvA.port,
      stdinBytes: encodeFrame({
        type: "request_token",
        assistantId: "assistant-b",
      }),
      timeoutMs: 2000,
      env: { VELLUM_LOCKFILE_DIR: lockfileDir },
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as {
      type: string;
      token: string;
      assistantPort: number;
      protocolVersion: number;
    };
    expect(frame.type).toBe("token_response");
    expect(frame.token).toBe("tok-b");
    expect(frame.assistantPort).toBe(srvB.port);
    expect(frame.protocolVersion).toBe(1);

    // srvB should have received the pair request, not srvA.
    expect(srvB.requests).toHaveLength(1);
    expect(srvA.requests).toHaveLength(0);
  });

  test("request_token without assistantId falls back to --assistant-port", async () => {
    const srvA = pairA!;
    srvA.requests.length = 0;
    srvA.nextResponseBody = () => ({
      token: "tok-fallback",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-fallback",
    });

    // Even with a lockfile present, omitting assistantId from the
    // frame should fall back to the --assistant-port CLI arg.
    const lockfileData = {
      assistants: [
        {
          assistantId: "some-assistant",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 55555 }, // unreachable port
        },
      ],
    };
    writeFileSync(
      join(lockfileDir, ".vellum.lock.json"),
      JSON.stringify(lockfileData),
    );

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srvA.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
      timeoutMs: 2000,
      env: { VELLUM_LOCKFILE_DIR: lockfileDir },
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as { type: string; token: string };
    expect(frame.type).toBe("token_response");
    expect(frame.token).toBe("tok-fallback");

    // The request went to srvA (via --assistant-port), not the
    // lockfile's unreachable port.
    expect(srvA.requests).toHaveLength(1);
  });

  test("request_token with unknown assistantId falls back to --assistant-port", async () => {
    const srvA = pairA!;
    srvA.requests.length = 0;
    srvA.nextResponseBody = () => ({
      token: "tok-unknown-fallback",
      expiresAt: "2026-12-31T00:00:00Z",
      guardianId: "g-unknown",
    });

    // Lockfile has assistant-a but we request token for "nonexistent".
    const lockfileData = {
      assistants: [
        {
          assistantId: "assistant-a",
          cloud: "local",
          runtimeUrl: "http://localhost:7830",
          resources: { daemonPort: 55555 },
        },
      ],
    };
    writeFileSync(
      join(lockfileDir, ".vellum.lock.json"),
      JSON.stringify(lockfileData),
    );

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: srvA.port,
      stdinBytes: encodeFrame({
        type: "request_token",
        assistantId: "nonexistent",
      }),
      timeoutMs: 2000,
      env: { VELLUM_LOCKFILE_DIR: lockfileDir },
    });

    expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
    const frame = result.frames[0] as { type: string; token: string };
    expect(frame.type).toBe("token_response");
    expect(frame.token).toBe("tok-unknown-fallback");
    expect(srvA.requests).toHaveLength(1);
  });
});
