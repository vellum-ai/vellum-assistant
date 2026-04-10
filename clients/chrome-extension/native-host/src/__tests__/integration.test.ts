/**
 * Subprocess integration tests for the Chrome native messaging helper.
 *
 * Spawns the compiled `dist/index.js` binary as a child process, wires a
 * tiny local HTTP server onto `127.0.0.1:<port>` that impersonates the
 * assistant's `/v1/browser-extension-pair` endpoint, pipes a framed
 * `request_token` message to the helper's stdin, and asserts that the
 * helper responds with a `token_response` frame on stdout.
 *
 * These tests exercise the end-to-end stdio framing contract that Chrome
 * relies on when spawning the helper via `chrome.runtime.connectNative`.
 * They also cover the `unauthorized_origin` rejection path.
 *
 * The tests skip gracefully if `dist/index.js` is missing — cold checkouts
 * and CI jobs that haven't run `bun run build` yet shouldn't fail here.
 * Run `bun run build` in this package before running these tests.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { decodeFrames, encodeFrame } from "../protocol.js";

// ---------------------------------------------------------------------------
// Paths & skip guard
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the built helper entry point. The test suite skips if
 * this file doesn't exist so the suite stays green on cold builds where
 * `bun run build` hasn't been invoked in the native-host package yet.
 */
const HELPER_BINARY = resolve(__dirname, "../../dist/index.js");

const HELPER_EXISTS = existsSync(HELPER_BINARY);

const ALLOWED_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const DISALLOWED_ORIGIN =
  "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/";

/**
 * Default skip message so every `test.skip` surface has the same actionable
 * explanation when the helper binary hasn't been built.
 */
const SKIP_REASON =
  "clients/chrome-extension/native-host/dist/index.js is missing — run `bun run build` in clients/chrome-extension/native-host to enable these tests.";

// ---------------------------------------------------------------------------
// Mock pair-endpoint HTTP server
// ---------------------------------------------------------------------------

interface MockPairServer {
  server: Server;
  port: number;
  /** Requests received by the mock server, in order. */
  requests: Array<{
    path: string;
    body: unknown;
    host: string | null;
    headers: Record<string, string>;
  }>;
  /** Token value returned by the next successful pair request. */
  nextToken: { token: string; expiresAt: string };
  /** If set, the mock returns this HTTP status instead of 200 on pair. */
  failWithStatus: number | null;
}

async function startMockPairServer(): Promise<MockPairServer> {
  const state: MockPairServer = {
    server: null as unknown as Server,
    port: 0,
    requests: [],
    nextToken: {
      token: "fake-token-from-mock-pair-server",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    failWithStatus: null,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      // Snapshot the headers as a plain object so tests can assert
      // on a stable surface. node:http lowercases header names, so
      // the keys are already the canonical wire form.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      state.requests.push({
        path: req.url ?? "",
        body,
        host: req.headers.host ?? null,
        headers,
      });

      if (req.url !== "/v1/browser-extension-pair" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      if (state.failWithStatus !== null) {
        res.statusCode = state.failWithStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "mock failure" }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          token: state.nextToken.token,
          expiresAt: state.nextToken.expiresAt,
          guardianId: "mock-guardian",
        }),
      );
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const addr = server.address() as AddressInfo;
  state.server = server;
  state.port = addr.port;
  return state;
}

async function stopMockPairServer(mock: MockPairServer): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    mock.server.close(() => resolvePromise());
  });
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface HelperRunResult {
  frames: unknown[];
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn the helper binary with the given extension origin + assistant
 * port, write the provided raw stdin bytes, then collect the decoded
 * response frames, stderr output, and exit code.
 *
 * The helper is a short-lived one-shot process (Chrome re-spawns it on
 * every `connectNative` call), so we drive it by writing stdin and then
 * closing it, then waiting for the process to exit.
 */
function runHelper(options: {
  extensionOrigin: string | null;
  assistantPort: number | null;
  stdinBytes: Buffer | null;
  timeoutMs?: number;
}): Promise<HelperRunResult> {
  const args: string[] = [HELPER_BINARY];
  if (options.extensionOrigin) args.push(options.extensionOrigin);
  if (options.assistantPort !== null) {
    args.push("--assistant-port", String(options.assistantPort));
  }

  const child: ChildProcessWithoutNullStreams = spawn("node", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  if (options.stdinBytes) {
    child.stdin.write(options.stdinBytes);
  }
  child.stdin.end();

  return new Promise<HelperRunResult>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(
          `helper binary timed out after ${options.timeoutMs ?? 5000}ms`,
        ),
      );
    }, options.timeoutMs ?? 5000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      try {
        const { frames } = decodeFrames(stdout);
        resolvePromise({ frames, stderr, exitCode: code });
      } catch (err) {
        rejectPromise(err as Error);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("native host helper — subprocess integration", () => {
  let mock: MockPairServer | null = null;

  beforeAll(async () => {
    if (!HELPER_EXISTS) return;
    mock = await startMockPairServer();
  });

  afterAll(async () => {
    if (mock) await stopMockPairServer(mock);
  });

  if (!HELPER_EXISTS) {
    test.skip(`native helper binary not built — ${SKIP_REASON}`, () => {
      /* intentionally empty — see skip reason */
    });
    return;
  }

  test("responds to request_token with a token_response frame", async () => {
    // Narrow the type for TypeScript — we know mock is non-null here
    // because the beforeAll returned early only when HELPER_EXISTS was
    // false, which would have routed us into the skip branch above.
    const pair = mock!;
    pair.nextToken = {
      token: "integration-test-token-value",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    const result = await runHelper({
      extensionOrigin: ALLOWED_ORIGIN,
      assistantPort: pair.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.frames).toHaveLength(1);

    const frame = result.frames[0] as {
      type: string;
      token?: string;
      expiresAt?: string;
      assistantPort?: number;
    };
    expect(frame.type).toBe("token_response");
    expect(frame.token).toBe("integration-test-token-value");
    expect(typeof frame.expiresAt).toBe("string");
    expect(frame.expiresAt!.length).toBeGreaterThan(0);

    // PR 3 of the browser-use remediation plan: the helper MUST echo
    // the assistant runtime port it used back to the chrome extension
    // so the extension can pin its self-hosted relay socket to the
    // same port (rather than falling back to the hard-coded
    // DEFAULT_RELAY_PORT). The helper resolves the port from the
    // `--assistant-port` CLI flag we passed above, so we assert it
    // round-trips to the exact port the test spun up.
    expect(frame.assistantPort).toBe(pair.port);

    // The mock server should have observed exactly one pair request
    // carrying the extension origin we passed on the command line.
    expect(pair.requests.length).toBe(1);
    expect(pair.requests[0]!.path).toBe("/v1/browser-extension-pair");
    expect(pair.requests[0]!.body).toEqual({ extensionOrigin: ALLOWED_ORIGIN });

    // PR4 of the browser-use remediation plan: the helper must set
    // the `x-vellum-native-host: 1` marker header on every pair
    // request so the assistant's pre-auth endpoint can reject
    // drive-by browser fetches.
    expect(pair.requests[0]!.headers["x-vellum-native-host"]).toBe("1");
  });

  test("rejects disallowed extension origin with an error frame", async () => {
    const pair = mock!;
    // Reset the request log so we can assert the helper never contacted
    // the pair endpoint in the unauthorized case.
    pair.requests.length = 0;

    const result = await runHelper({
      extensionOrigin: DISALLOWED_ORIGIN,
      assistantPort: pair.port,
      stdinBytes: encodeFrame({ type: "request_token" }),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.frames).toHaveLength(1);
    const frame = result.frames[0] as { type: string; message?: string };
    expect(frame.type).toBe("error");
    expect(frame.message).toBe("unauthorized_origin");

    // No pair request should have been sent — the helper rejects
    // unknown extension origins before touching the network.
    expect(pair.requests.length).toBe(0);
  });

  test("surfaces an error frame when the pair endpoint fails", async () => {
    const pair = mock!;
    pair.requests.length = 0;
    pair.failWithStatus = 500;

    try {
      const result = await runHelper({
        extensionOrigin: ALLOWED_ORIGIN,
        assistantPort: pair.port,
        stdinBytes: encodeFrame({ type: "request_token" }),
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.frames).toHaveLength(1);
      const frame = result.frames[0] as { type: string; message?: string };
      expect(frame.type).toBe("error");
      // The helper wraps HTTP errors in a descriptive message; just
      // assert it mentions the failure rather than pinning the exact
      // phrasing, which is an implementation detail.
      expect(typeof frame.message).toBe("string");
      expect(frame.message).toMatch(/pair/i);
    } finally {
      pair.failWithStatus = null;
    }
  });
});
