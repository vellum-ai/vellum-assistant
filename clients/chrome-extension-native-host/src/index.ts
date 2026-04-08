#!/usr/bin/env node
/**
 * Vellum chrome-extension native messaging helper.
 *
 * This binary is spawned by Chrome when the Vellum browser extension calls
 * `chrome.runtime.connectNative("com.vellum.daemon")`. It speaks the Chrome
 * native messaging stdio protocol (4-byte little-endian length prefix +
 * UTF-8 JSON) on stdin/stdout.
 *
 * Responsibilities:
 *
 *   1. Verify that the calling extension's origin (passed by Chrome as the
 *      first command-line argument, e.g. `chrome-extension://<id>/`) is on a
 *      hard-coded allowlist of known Vellum extension IDs.
 *   2. Listen on stdin for `{ type: "request_token" }` frames.
 *   3. POST the calling extension's origin to the running assistant's
 *      `/v1/browser-extension-pair` endpoint (port resolved from
 *      `--assistant-port`, then `~/.vellum/runtime-port`, then defaulting to
 *      7821).
 *   4. Echo the assistant's response back to Chrome as a
 *      `{ type: "token_response", token, expiresAt, guardianId }` frame.
 *   5. On any unrecoverable error, write a `{ type: "error", message }` frame
 *      and exit with a non-zero status.
 *
 * The helper deliberately does NOT persist tokens — the extension is
 * responsible for storing the returned token in `chrome.storage.local`.
 *
 * The pairing flow as a whole consists of: (a) this helper, (b) the
 * assistant-side `/v1/browser-extension-pair` endpoint that mints the
 * capability token, and (c) the macOS installer wiring that drops the
 * compiled binary alongside the native-messaging host manifest Chrome
 * reads to resolve `com.vellum.daemon`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeFrames, encodeFrame, FrameDecodeError } from "./protocol.js";

/**
 * Allowlist of Chrome extension IDs that are permitted to spawn this helper.
 *
 * Chrome passes the calling extension's origin as the first positional
 * argument, e.g. `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/`.
 * Anything not on this list is rejected before any further processing.
 */
const ALLOWED_EXTENSION_IDS: ReadonlySet<string> = new Set<string>([
  // Dev placeholder — replaced when the unpacked extension is loaded locally.
  // TODO: production id before release
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]);

const DEFAULT_ASSISTANT_PORT = 7821;
const RUNTIME_PORT_FILE = join(homedir(), ".vellum", "runtime-port");

interface TokenResponse {
  token: string;
  expiresAt: string;
  guardianId: string;
}

/**
 * Parse a `--assistant-port <number>` (or `--assistant-port=<number>`)
 * argument out of `process.argv`. Returns the parsed port if present and
 * valid, otherwise `null`.
 *
 * This is intentionally a tiny hand-rolled parser rather than a full CLI
 * library: the helper is invoked by Chrome's native messaging runtime which
 * has a fixed argv shape, and pulling in a CLI dependency would bloat the
 * audited surface for no real gain.
 */
function parseAssistantPortArg(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let raw: string | undefined;
    if (arg === "--assistant-port") {
      raw = argv[i + 1];
    } else if (arg.startsWith("--assistant-port=")) {
      raw = arg.slice("--assistant-port=".length);
    } else {
      continue;
    }
    if (raw === undefined) return null;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    return null;
  }
  return null;
}

/**
 * Resolve the assistant's HTTP port. Resolution order:
 *
 *   1. `--assistant-port <port>` CLI flag (highest precedence). This exists
 *      so a wrapper script registered in Chrome's NativeMessagingHosts
 *      manifest can pin the helper to a known port without relying on a
 *      lockfile.
 *   2. `~/.vellum/runtime-port` lockfile (a single integer). This file is
 *      not yet written by the assistant — see the TODO in this package's
 *      README. Once it is, no manifest changes are needed for default
 *      installs.
 *   3. The well-known default port `7821`.
 *
 * Any read or parse failure on the lockfile silently falls through to the
 * default rather than crashing — the assistant is the ultimate source of
 * truth and the subsequent HTTP call will surface a clear connection error.
 */
function resolveAssistantPort(argv: readonly string[]): number {
  const fromArg = parseAssistantPortArg(argv);
  if (fromArg !== null) return fromArg;
  try {
    const raw = readFileSync(RUNTIME_PORT_FILE, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  } catch {
    // Fall through to the default. This is expected on first launch and in
    // dev environments where the port file hasn't been written yet.
  }
  return DEFAULT_ASSISTANT_PORT;
}

/**
 * Extract the bare extension id from a `chrome-extension://<id>/` origin.
 * Returns `null` if the input doesn't match the expected shape.
 */
function parseExtensionId(origin: string | undefined): string | null {
  if (!origin) return null;
  const match = origin.match(/^chrome-extension:\/\/([a-p]{32})\/?$/);
  return match ? match[1]! : null;
}

/**
 * Writes a native-messaging frame to stdout and terminates the process
 * synchronously. The exit code is the authoritative signal to Chrome;
 * the frame body is best-effort. Use this for error paths (unauthorized
 * origin, malformed requests) where Chrome only needs to observe a
 * non-zero exit and any frame-body truncation is acceptable.
 *
 * Typed `never` because `process.exit()` never returns, which lets
 * callers treat this as an unconditional terminator with no event-loop
 * tick between the write and the exit.
 */
function writeErrorFrameAndExit(payload: unknown, exitCode: number): never {
  try {
    process.stdout.write(encodeFrame(payload));
  } catch {
    // Ignore — exit code is the authoritative signal here.
  }
  process.exit(exitCode);
}

/**
 * Writes a native-messaging frame to stdout and terminates the process
 * only after libuv has flushed the write to the pipe. Use this for
 * success paths (e.g., `token_response`) where Chrome needs the full
 * frame body to drive the extension's pairing flow.
 *
 * The callback form of `process.stdout.write()` fires once the buffer
 * has been handed off to the kernel, so awaiting the returned Promise
 * guarantees the frame made it across the pipe before the process
 * exits. This matters on pipe-backed stdout (Chrome native messaging)
 * where a sync `process.exit()` can terminate before libuv finishes
 * flushing a large-enough frame — most visibly on Windows.
 *
 * The Promise never resolves: the callback always ends in
 * `process.exit(exitCode)`, so from the caller's perspective an `await`
 * on this function is a terminator. A defensive 5-second safety timeout
 * rejects if the callback somehow never fires; the timer is `.unref()`ed
 * so it cannot keep the event loop alive on its own.
 */
function writeFrameAndExitAsync(
  payload: unknown,
  exitCode: number,
): Promise<never> {
  return new Promise<never>((_, reject) => {
    process.stdout.write(encodeFrame(payload), () => {
      // Best-effort: exit with the intended code even if the callback
      // reports a write error. Chrome will observe a disconnect on the
      // pipe and report the error through its native-messaging UI.
      process.exit(exitCode);
    });
    const safety = setTimeout(() => {
      reject(
        new Error(
          "writeFrameAndExitAsync timed out waiting for stdout flush",
        ),
      );
    }, 5000);
    safety.unref?.();
  });
}

/**
 * Emit an `error` frame and exit with a non-zero status. Also logs the
 * underlying message to stderr so an operator running the binary by hand
 * (or a Chrome extension developer inspecting the host's stderr stream)
 * can see what went wrong.
 *
 * Uses `writeErrorFrameAndExit` so the error frame is written to stdout
 * before the process terminates. `writeErrorFrameAndExit` handles its
 * own write failures internally, so no additional try/catch is needed
 * here.
 */
function fail(message: string, code = 1): never {
  process.stderr.write(`vellum-chrome-native-host: ${message}\n`);
  writeErrorFrameAndExit({ type: "error", message }, code);
}

/**
 * POST the extension origin to the assistant's pair endpoint and return the
 * issued capability token. Surfaces a uniform error message on failure so
 * the caller can wrap it in a native-messaging error frame.
 *
 * Note: error messages here are user-visible (they get propagated to Chrome
 * as `{ type: "error", message }` frames and surfaced in the extension UI),
 * so per AGENTS.md they refer to the local process as the "assistant" rather
 * than the internal "daemon" name.
 */
async function requestToken(
  extensionOrigin: string,
  argv: readonly string[],
): Promise<TokenResponse> {
  const port = resolveAssistantPort(argv);
  const url = `http://127.0.0.1:${port}/v1/browser-extension-pair`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extensionOrigin }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to reach assistant at ${url}: ${detail}`);
  }

  if (!response.ok) {
    throw new Error(
      `assistant pair request failed with HTTP ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`assistant pair response was not valid JSON: ${detail}`);
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { token?: unknown }).token !== "string" ||
    typeof (body as { expiresAt?: unknown }).expiresAt !== "string"
  ) {
    throw new Error("assistant pair response missing token / expiresAt");
  }

  const { token, expiresAt, guardianId } = body as TokenResponse;
  if (typeof guardianId !== "string" || guardianId.length === 0) {
    throw new Error("pair endpoint response missing guardianId");
  }
  return { token, expiresAt, guardianId };
}

async function main(): Promise<void> {
  // Chrome passes the calling extension's origin (e.g.
  // `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/`) as the first
  // positional argument when it spawns the native messaging host.
  //
  // Where that lands in `process.argv` depends on how the manifest's `path`
  // is set up: if it points directly at a compiled binary, the origin shows
  // up at `argv[1]`; if it points at a wrapper shell script that re-execs
  // `node dist/index.js "$@"`, the origin lands at `argv[2]` (because Node
  // takes argv[0] = node and argv[1] = the script path). To stay robust
  // across both deployment shapes we scan all post-argv[0] arguments for
  // the first one that looks like a `chrome-extension://` URL.
  const extensionOrigin = process.argv
    .slice(1)
    .find((arg) => arg.startsWith("chrome-extension://"));
  const extensionId = parseExtensionId(extensionOrigin);

  if (!extensionId || !ALLOWED_EXTENSION_IDS.has(extensionId)) {
    process.stderr.write(
      `vellum-chrome-native-host: unauthorized_origin (got ${extensionOrigin ?? "<none>"})\n`,
    );
    writeErrorFrameAndExit(
      { type: "error", message: "unauthorized_origin" },
      1,
    );
    // Defense-in-depth: even though writeErrorFrameAndExit calls
    // process.exit synchronously and is typed `never`, an explicit
    // `return` here guarantees we never fall through to the stdin
    // listener setup below if a future refactor accidentally makes the
    // helper async.
    return;
  }

  // Reading stdin in 4-byte-framed chunks. Chrome may deliver a single
  // request across multiple `data` events, so we accumulate into a buffer
  // and let `decodeFrames` peel off whole messages as they arrive.
  let pending: Buffer = Buffer.alloc(0);
  let handling = false;

  process.stdin.on("data", async (chunk: Buffer) => {
    // The entire handler body is wrapped in a try/catch so that any
    // unexpected exception (most notably `FrameDecodeError` from a
    // malformed JSON body, but also any synchronous error before the
    // request reaches `requestToken`) is translated into a protocol-level
    // `error` frame instead of bubbling up to Node's unhandled-rejection
    // path and silently exit-1'ing the process.
    try {
      pending = Buffer.concat([pending, chunk]);
      const { frames, remainder } = decodeFrames(pending);
      pending = remainder;

      for (const frame of frames) {
        if (handling) {
          // We only support a single in-flight request per spawn — Chrome
          // re-spawns the helper on every `connectNative` call. Anything
          // beyond the first frame is treated as a protocol error.
          fail("unexpected_additional_frame");
        }
        handling = true;

        if (
          !frame ||
          typeof frame !== "object" ||
          (frame as { type?: unknown }).type !== "request_token"
        ) {
          fail("unsupported_frame_type");
        }

        try {
          const { token, expiresAt, guardianId } = await requestToken(
            extensionOrigin!,
            process.argv,
          );
          await writeFrameAndExitAsync(
            { type: "token_response", token, expiresAt, guardianId },
            0,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fail(message);
        }
      }
    } catch (err) {
      // `FrameDecodeError` is the most likely culprit here (malformed JSON
      // body in a stdin frame), but we deliberately funnel any synchronous
      // exception thrown out of `decodeFrames` or the dispatch loop above
      // through this single catch so the helper always gets a chance to
      // emit a structured `error` frame instead of dying with an
      // unhandled exception.
      const detail =
        err instanceof FrameDecodeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      fail(`protocol_error: ${detail}`);
    }
  });

  process.stdin.on("end", () => {
    if (!handling) {
      // Chrome closed the pipe without sending a request — treat as a
      // clean no-op exit so we don't pollute logs with bogus errors.
      process.exit(0);
    }
  });

  process.stdin.on("error", (err) => {
    fail(`stdin_error: ${err.message}`);
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
