/**
 * End-to-end smoke test for the self-hosted native-messaging capability
 * bootstrap path.
 *
 * This test exercises the full flow at the subprocess boundary:
 *
 *   1. A minimal Bun HTTP server mounts the real
 *      `handleBrowserExtensionPair` route from the assistant runtime.
 *   2. The compiled native helper binary
 *      (`clients/chrome-extension-native-host/dist/index.js`) is spawned as
 *      a child process and pointed at that server via the `--assistant-port`
 *      CLI flag.
 *   3. The test writes a Chrome-native-messaging-framed
 *      `{ type: "request_token" }` to the helper's stdin.
 *   4. The helper POSTs `/v1/browser-extension-pair` on the test server,
 *      gets back a capability token + guardianId, and echoes them to stdout
 *      as a `token_response` frame.
 *   5. The test asserts the returned token verifies via
 *      `verifyHostBrowserCapability` — i.e. a fresh install can pair the
 *      Chrome extension via the native helper end-to-end without any
 *      shortcuts.
 *
 * The test **skips gracefully** if the native helper hasn't been built
 * (`clients/chrome-extension-native-host/dist/index.js` missing). Run
 * `bun run build` in that package first to enable the full path.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  mintHostBrowserCapability,
  resetCapabilityTokenSecretForTests,
  setCapabilityTokenSecretForTests,
  verifyHostBrowserCapability,
} from "../runtime/capability-tokens.js";
import { handleBrowserExtensionPair } from "../runtime/routes/browser-extension-pair-routes.js";

// ---------------------------------------------------------------------------
// Native helper binary discovery + skip guard
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the compiled native helper. The helper lives in a
 * sibling package under `clients/chrome-extension-native-host/`, so we
 * walk up from `assistant/src/__tests__/` to the repo root and then back
 * down into the native-host package.
 */
function resolveHelperBinary(): string {
  // `import.meta.dir` gives us `.../assistant/src/__tests__`. The repo
  // root is three levels up. Past that, the native host lives at
  // `clients/chrome-extension-native-host/dist/index.js`.
  return resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "clients",
    "chrome-extension-native-host",
    "dist",
    "index.js",
  );
}

const HELPER_BINARY = resolveHelperBinary();
const HELPER_EXISTS = existsSync(HELPER_BINARY);

const ALLOWED_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

const SKIP_REASON =
  "clients/chrome-extension-native-host/dist/index.js is missing — run `bun run build` in that package to enable the E2E smoke test.";

// ---------------------------------------------------------------------------
// Chrome native messaging framing (4-byte LE length prefix + UTF-8 JSON)
// ---------------------------------------------------------------------------

/**
 * These helpers are duplicated from the native-host package's
 * `protocol.ts` so this test is self-contained and does not reach across
 * package boundaries at import time. The framing is fixed by the Chrome
 * native messaging protocol spec, so there is no risk of drift.
 */
function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([len, json]);
}

function decodeFrames(buf: Buffer): {
  frames: unknown[];
  remainder: Buffer;
} {
  const frames: unknown[] = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32LE(offset);
    if (buf.length - offset - 4 < len) break;
    const body = buf.subarray(offset + 4, offset + 4 + len);
    frames.push(JSON.parse(body.toString("utf8")));
    offset += 4 + len;
  }
  return { frames, remainder: buf.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Minimal pair-endpoint HTTP server using the real route handler
// ---------------------------------------------------------------------------

interface PairServer {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => void;
}

/**
 * Boots a minimal Bun.serve that mounts the real
 * `handleBrowserExtensionPair` route. This is intentionally a narrower
 * surface than `RuntimeHttpServer` — we want to exercise the exact same
 * route handler the daemon uses in production, but without pulling in the
 * full runtime's dependency graph (which would drag in the workspace DB,
 * conversation manager, etc. and make the test flaky + slow).
 */
function startPairServer(): PairServer {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/browser-extension-pair") {
        return handleBrowserExtensionPair(req, {
          requestIP: (_req) => srv.requestIP(_req),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    server,
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface HelperRunResult {
  frames: unknown[];
  stderr: string;
  exitCode: number | null;
}

function runHelper(options: {
  extensionOrigin: string;
  assistantPort: number;
  stdinBytes: Buffer;
  timeoutMs?: number;
}): Promise<HelperRunResult> {
  const args: string[] = [
    HELPER_BINARY,
    options.extensionOrigin,
    "--assistant-port",
    String(options.assistantPort),
  ];

  const child: ChildProcessWithoutNullStreams = spawn("node", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  child.stdin.write(options.stdinBytes);
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

describe("host-browser E2E — self-hosted native messaging path", () => {
  let pairServer: PairServer | null = null;

  beforeAll(() => {
    // Pin the capability-token secret to a deterministic test value so
    // the token the route mints can round-trip through
    // `verifyHostBrowserCapability` in this process. Both sides of the
    // flow share the same in-process module, so setting the secret once
    // is enough for both mint + verify to agree.
    resetCapabilityTokenSecretForTests();
    setCapabilityTokenSecretForTests(randomBytes(32));

    if (!HELPER_EXISTS) return;
    pairServer = startPairServer();
  });

  afterAll(() => {
    if (pairServer) pairServer.stop();
    resetCapabilityTokenSecretForTests();
  });

  if (!HELPER_EXISTS) {
    // Native helper hasn't been built; emit a warning so the gap is
    // visible in test output without registering a placeholder test.
    console.warn(`[host-browser-e2e] ${SKIP_REASON}`);
  } else {
    test("pair flow: request_token -> token_response -> verifiable capability token", async () => {
      // Narrow for TS — pairServer is always set in this branch thanks to
      // the beforeAll guard that mirrors HELPER_EXISTS.
      const srv = pairServer!;

      const result = await runHelper({
        extensionOrigin: ALLOWED_ORIGIN,
        assistantPort: srv.port,
        stdinBytes: encodeFrame({ type: "request_token" }),
      });

      // Helper should have exited cleanly after writing one token_response
      // frame. Pipe any stderr into the assertion message to make
      // debugging failures easier.
      expect(result.exitCode, `helper stderr: ${result.stderr}`).toBe(0);
      expect(result.frames).toHaveLength(1);

      const frame = result.frames[0] as {
        type: string;
        token?: string;
        expiresAt?: string;
        guardianId?: string;
      };
      expect(frame.type).toBe("token_response");
      expect(typeof frame.token).toBe("string");
      expect(frame.token!.length).toBeGreaterThan(0);
      expect(typeof frame.expiresAt).toBe("string");

      // Gap 3 regression guard: the helper must surface the
      // guardianId returned by /v1/browser-extension-pair on the
      // native-messaging frame so the chrome extension's
      // bootstrapLocalToken() can persist it. The route's
      // resolveLocalGuardianId() falls back to the literal string
      // "local" when no vellum guardian is bootstrapped, which is
      // the case in this test environment, so we assert against the
      // exact value as well as a non-empty type guard.
      expect(typeof frame.guardianId).toBe("string");
      expect(frame.guardianId!.length).toBeGreaterThan(0);
      expect(frame.guardianId).toBe("local");

      // The returned token must verify via the in-process capability
      // verifier — this is the core invariant the native-messaging
      // bootstrap promises. The daemon is the only party that could
      // have signed this, so a successful verification proves the
      // end-to-end pair flow worked.
      const claims = verifyHostBrowserCapability(frame.token!);
      expect(claims).not.toBeNull();
      expect(claims?.capability).toBe("host_browser_command");
      expect(typeof claims?.guardianId).toBe("string");
      expect(claims?.guardianId.length).toBeGreaterThan(0);
      // The frame's guardianId should match the claim's guardianId —
      // both originate from the same `resolveLocalGuardianId()` call
      // inside the route handler.
      expect(frame.guardianId).toBe(claims?.guardianId);
      // expiresAt in the response frame should agree with the numeric
      // claim expiry to within ISO-string precision.
      const iso = new Date(claims!.expiresAt).toISOString();
      expect(frame.expiresAt).toBe(iso);
    });
  }

  // -------------------------------------------------------------------------
  // Dev-only `~/.vellum/daemon-token` fallback
  // -------------------------------------------------------------------------

  describe("dev daemon-token fallback path", () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "vellum-daemon-token-test-"));
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("a token written to a local file round-trips through verifyHostBrowserCapability", () => {
      // Emulate the `writeDaemonTokenFallback` lifecycle: mint a fresh
      // capability token, persist it to a 0600 file (the production
      // helper writes to `~/.vellum/daemon-token`, but we use a tempdir
      // so the test doesn't clobber real dev state), then read it back
      // and verify.
      //
      // This path is what the Mac app's manual "paste daemon token"
      // pairing UI ends up exercising — the file on disk is the only
      // transport. If the bytes on disk don't round-trip through
      // `verifyHostBrowserCapability`, manual pairing is broken.
      resetCapabilityTokenSecretForTests();
      setCapabilityTokenSecretForTests(randomBytes(32));

      const { token, expiresAt } = mintHostBrowserCapability("local");
      expect(expiresAt).toBeGreaterThan(Date.now());

      const tokenPath = join(tmpDir, "daemon-token");
      writeFileSync(tokenPath, token, { mode: 0o600 });
      // Explicitly chmod in case the umask clobbered the mode arg to
      // writeFileSync (best-effort — some filesystems ignore this).
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        /* ignore */
      }

      const readBack = readFileSync(tokenPath, "utf8");
      expect(readBack).toBe(token);

      const claims = verifyHostBrowserCapability(readBack);
      expect(claims).not.toBeNull();
      expect(claims?.capability).toBe("host_browser_command");
      expect(claims?.guardianId).toBe("local");
    });
  });
});
