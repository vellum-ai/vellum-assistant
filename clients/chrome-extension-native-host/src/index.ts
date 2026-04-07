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
 *   3. POST the calling extension's origin to the running daemon's
 *      `/v1/browser-extension-pair` endpoint (port resolved from
 *      `~/.vellum/runtime-port` or defaulting to 7821).
 *   4. Echo the daemon's response back to Chrome as a
 *      `{ type: "token_response", token, expiresAt }` frame.
 *   5. On any unrecoverable error, write a `{ type: "error", message }` frame
 *      and exit with a non-zero status.
 *
 * The helper deliberately does NOT persist tokens — the extension is
 * responsible for storing the returned token in `chrome.storage.local`.
 *
 * See PR 11 (`/v1/browser-extension-pair` endpoint) and PR 12 (native
 * messaging host manifest + macOS installer wiring) for the rest of the
 * pairing flow.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { decodeFrames, encodeFrame } from "./protocol.js";

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

const DEFAULT_DAEMON_PORT = 7821;
const RUNTIME_PORT_FILE = join(homedir(), ".vellum", "runtime-port");

interface TokenResponse {
  token: string;
  expiresAt: string;
}

/**
 * Resolve the daemon's HTTP port. The Mac app writes the active port to
 * `~/.vellum/runtime-port` on startup; if the file is missing or unreadable
 * we fall back to the well-known default. Any parse failure also falls back
 * rather than crashing — the daemon is the ultimate source of truth and the
 * subsequent HTTP call will surface a clear connection error.
 */
function resolveDaemonPort(): number {
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
  return DEFAULT_DAEMON_PORT;
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
 * Write a single native-messaging frame to stdout. Uses the synchronous
 * write path so the caller can `process.exit()` immediately after without
 * losing the frame in a buffered queue.
 */
function writeFrame(payload: unknown): void {
  process.stdout.write(encodeFrame(payload));
}

/**
 * Emit an `error` frame and exit with a non-zero status. Also logs the
 * underlying message to stderr so an operator running the binary by hand
 * (or a Chrome extension developer inspecting the host's stderr stream)
 * can see what went wrong.
 */
function fail(message: string, code = 1): never {
  process.stderr.write(`vellum-chrome-native-host: ${message}\n`);
  try {
    writeFrame({ type: "error", message });
  } catch {
    // If even writing the error frame fails (e.g. stdout already closed),
    // there's nothing useful to do — just exit.
  }
  process.exit(code);
}

/**
 * POST the extension origin to the daemon's pair endpoint and return the
 * issued capability token. Surfaces a uniform error message on failure so
 * the caller can wrap it in a native-messaging error frame.
 */
async function requestToken(extensionOrigin: string): Promise<TokenResponse> {
  const port = resolveDaemonPort();
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
    throw new Error(`failed to reach daemon at ${url}: ${detail}`);
  }

  if (!response.ok) {
    throw new Error(`daemon pair request failed with HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`daemon pair response was not valid JSON: ${detail}`);
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { token?: unknown }).token !== "string" ||
    typeof (body as { expiresAt?: unknown }).expiresAt !== "string"
  ) {
    throw new Error("daemon pair response missing token / expiresAt");
  }

  const { token, expiresAt } = body as TokenResponse;
  return { token, expiresAt };
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
    try {
      writeFrame({ type: "error", message: "unauthorized_origin" });
    } catch {
      // Ignore — exit code is the authoritative signal here.
    }
    process.exit(1);
  }

  // Reading stdin in 4-byte-framed chunks. Chrome may deliver a single
  // request across multiple `data` events, so we accumulate into a buffer
  // and let `decodeFrames` peel off whole messages as they arrive.
  let pending: Buffer = Buffer.alloc(0);
  let handling = false;

  process.stdin.on("data", async (chunk: Buffer) => {
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
        const { token, expiresAt } = await requestToken(extensionOrigin!);
        writeFrame({ type: "token_response", token, expiresAt });
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fail(message);
      }
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
