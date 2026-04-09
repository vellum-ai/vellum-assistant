/**
 * DevTools HTTP discovery helpers for the `cdp-inspect` backend.
 *
 * These helpers are pure HTTP/domain logic — they do not own a
 * websocket transport, a session manager, or any CDP command state.
 * They exist so the higher-level `cdp-inspect` client can:
 *
 * 1. Probe `/json/version` to verify that a loopback port is actually
 *    a Chrome/Chromium DevTools endpoint (and not some other service
 *    that happens to be listening).
 * 2. Enumerate available page targets via `/json/list`.
 * 3. Pick a sensible default target when the caller doesn't specify
 *    one explicitly.
 *
 * Safety boundary: **only loopback hosts are allowed**. A non-loopback
 * host is rejected *before* any network I/O so that this module can
 * never be coerced into making cross-origin requests on behalf of an
 * attacker-controlled config value.
 */

/**
 * Stable error codes surfaced by discovery helpers.
 *
 * Callers branch on these codes instead of string-matching messages so
 * upstream UX (status bar, toasts, logs) can render a stable, localized
 * explanation.
 */
export type DevToolsDiscoveryErrorCode =
  | "unreachable"
  | "non_loopback"
  | "non_chrome"
  | "invalid_response"
  | "no_targets"
  | "timeout";

/**
 * Single error type thrown by all discovery helpers. Mirrors the
 * shape of {@link import("../errors.js").CdpError} so catch sites can
 * rely on an explicit `code` field and an optional underlying cause.
 */
export class DevToolsDiscoveryError extends Error {
  constructor(
    public readonly code: DevToolsDiscoveryErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DevToolsDiscoveryError";
  }
}

/**
 * Normalized `/json/version` payload. Chrome returns canonical field
 * names like `Browser` and `Protocol-Version`, but some forks and
 * tests prefer camelCase. The parser here accepts both and normalizes
 * to the camelCase shape below.
 */
export interface DevToolsVersionInfo {
  /** Normalized from `"Browser"` or `"browser"`. */
  browser: string;
  /** Normalized from `"Protocol-Version"` or `"protocolVersion"`. */
  protocolVersion: string;
  /** WebSocket URL for the browser-level debugger endpoint. */
  webSocketDebuggerUrl: string;
}

/**
 * A DevTools page target as returned by `/json/list`, filtered down to
 * the fields the cdp-inspect backend actually needs.
 */
export interface DevToolsTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Loopback allowlist (exact match, case-insensitive). Any host not in
 * this list is rejected *before* we touch the network.
 *
 * We intentionally do not resolve DNS here — if a config ever gains a
 * hostname that happens to resolve to 127.0.0.1, we still refuse it,
 * because DNS rebinding attacks can flip that answer between the
 * pre-check and the actual fetch.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertLoopback(host: string): void {
  const normalized = host.toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new DevToolsDiscoveryError(
      "non_loopback",
      `Refusing to probe non-loopback DevTools host "${host}". Only loopback hosts (localhost, 127.0.0.1, ::1) are permitted.`,
    );
  }
}

/**
 * Build a fetch-ready loopback URL. `host` is assumed to have already
 * been validated by {@link assertLoopback}. IPv6 bare form (`::1`) is
 * wrapped in square brackets for URL correctness.
 */
function buildUrl(host: string, port: number, pathname: string): string {
  const normalized = host.toLowerCase();
  const hostSegment = normalized === "::1" ? "[::1]" : normalized;
  return `http://${hostSegment}:${port}${pathname}`;
}

/**
 * Timeout controller handle returned by {@link withTimeout}. `cleanup`
 * must be called in a `finally` block to avoid leaking the timer and
 * the abort listener. `timedOut` is flipped to `true` if the timer
 * fires before `cleanup` runs.
 */
interface TimeoutHandle {
  signal: AbortSignal;
  cleanup: () => void;
  readonly timedOut: boolean;
}

/**
 * Merge the caller's signal (if any) with a freshly-minted timeout
 * controller. The flag on the returned handle is the single source of
 * truth for "timed out vs. aborted vs. network error" — we can't
 * recover that distinction from the fetch rejection alone.
 */
function withTimeout(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): TimeoutHandle {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);

  let onCallerAbort: (() => void) | null = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cleanup: () => {
      clearTimeout(timer);
      if (onCallerAbort && callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

/**
 * Classify a `fetch()` rejection into a stable discovery code. We
 * intentionally do not depend on Node's error code strings here — the
 * fetch implementation varies between Bun, Node, and undici — so we
 * look at the name, the message, and the caller-visible abort state
 * instead.
 */
function classifyFetchError(
  err: unknown,
  timedOut: boolean,
  callerAborted: boolean,
): DevToolsDiscoveryError {
  if (callerAborted) {
    return new DevToolsDiscoveryError(
      "unreachable",
      "Discovery fetch was aborted by the caller before completion.",
      err,
    );
  }
  if (timedOut) {
    return new DevToolsDiscoveryError(
      "timeout",
      "Timed out waiting for DevTools HTTP response.",
      err,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || /aborted/i.test(message)) {
    // Unspecified abort — most likely the timeout fired but the flag
    // was not flipped yet. Treat as timeout to give the user the
    // clearer message.
    return new DevToolsDiscoveryError(
      "timeout",
      "Timed out waiting for DevTools HTTP response.",
      err,
    );
  }

  return new DevToolsDiscoveryError(
    "unreachable",
    `Failed to reach DevTools endpoint: ${message}`,
    err,
  );
}

/**
 * Best-effort JSON parser. Returns a parsed object or throws a
 * discovery error with `invalid_response` so the caller doesn't need
 * to wrap this itself.
 */
async function parseJsonResponse(
  response: Response,
  endpoint: string,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      `Failed to read ${endpoint} response body.`,
      err,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      `Expected JSON from ${endpoint} but got: ${text.slice(0, 200)}`,
      err,
    );
  }
}

/**
 * Pull a string field out of an arbitrary JSON object, supporting
 * either of two casings (e.g. `"Browser"` and `"browser"`). Returns
 * `undefined` if neither key exists or the value is not a string.
 */
function readStringField(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Probe `/json/version` on a loopback DevTools endpoint and return a
 * normalized {@link DevToolsVersionInfo}.
 *
 * Failure modes:
 *
 * - `non_loopback`: host is not one of {localhost, 127.0.0.1, ::1, [::1]}.
 *   Raised *before* any network I/O.
 * - `unreachable`: network error, connection refused, DNS failure, etc.
 * - `timeout`: no response within `timeoutMs`.
 * - `invalid_response`: HTTP status != 200, non-JSON body, or missing
 *   required fields.
 * - `non_chrome`: the responder does not identify itself as Chrome or
 *   Chromium. Guards against e.g. a dev server happening to listen on
 *   port 9222.
 */
export async function probeDevToolsJsonVersion(opts: {
  host: string;
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DevToolsVersionInfo> {
  assertLoopback(opts.host);

  const url = buildUrl(opts.host, opts.port, "/json/version");
  const handle = withTimeout(opts.timeoutMs, opts.signal);

  let response: Response;
  try {
    response = await fetch(url, { signal: handle.signal });
  } catch (err) {
    throw classifyFetchError(
      err,
      handle.timedOut,
      opts.signal?.aborted === true,
    );
  } finally {
    handle.cleanup();
  }

  if (!response.ok) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      `DevTools /json/version returned HTTP ${response.status}.`,
    );
  }

  const parsed = await parseJsonResponse(response, "/json/version");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      "DevTools /json/version payload is not a JSON object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const browser = readStringField(record, "Browser", "browser");
  const protocolVersion = readStringField(
    record,
    "Protocol-Version",
    "protocolVersion",
  );
  const webSocketDebuggerUrl = readStringField(
    record,
    "webSocketDebuggerUrl",
    "WebSocketDebuggerUrl",
  );

  if (!browser || !protocolVersion || !webSocketDebuggerUrl) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      "DevTools /json/version payload is missing required fields (browser, protocolVersion, webSocketDebuggerUrl).",
    );
  }

  if (!/chrom(e|ium)/i.test(browser)) {
    throw new DevToolsDiscoveryError(
      "non_chrome",
      `DevTools endpoint is not Chrome or Chromium: ${browser}`,
    );
  }

  return { browser, protocolVersion, webSocketDebuggerUrl };
}

/**
 * Enumerate `/json/list` and return only usable page targets — i.e.
 * `type === "page"` with a non-empty `webSocketDebuggerUrl`. Throws
 * `no_targets` when the filtered list is empty so the caller doesn't
 * have to decide how to phrase that.
 *
 * Sibling failure modes match {@link probeDevToolsJsonVersion}:
 * `non_loopback`, `unreachable`, `timeout`, `invalid_response`.
 */
export async function listDevToolsTargets(opts: {
  host: string;
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DevToolsTarget[]> {
  assertLoopback(opts.host);

  const url = buildUrl(opts.host, opts.port, "/json/list");
  const handle = withTimeout(opts.timeoutMs, opts.signal);

  let response: Response;
  try {
    response = await fetch(url, { signal: handle.signal });
  } catch (err) {
    throw classifyFetchError(
      err,
      handle.timedOut,
      opts.signal?.aborted === true,
    );
  } finally {
    handle.cleanup();
  }

  if (!response.ok) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      `DevTools /json/list returned HTTP ${response.status}.`,
    );
  }

  const parsed = await parseJsonResponse(response, "/json/list");
  if (!Array.isArray(parsed)) {
    throw new DevToolsDiscoveryError(
      "invalid_response",
      "DevTools /json/list payload is not a JSON array.",
    );
  }

  const targets: DevToolsTarget[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = readStringField(record, "type");
    if (type !== "page") continue;

    const webSocketDebuggerUrl = readStringField(
      record,
      "webSocketDebuggerUrl",
    );
    if (!webSocketDebuggerUrl) continue;

    const id = readStringField(record, "id") ?? "";
    const title = readStringField(record, "title") ?? "";
    const targetUrl = readStringField(record, "url") ?? "";

    targets.push({
      id,
      type,
      title,
      url: targetUrl,
      webSocketDebuggerUrl,
    });
  }

  if (targets.length === 0) {
    throw new DevToolsDiscoveryError(
      "no_targets",
      "No usable page targets returned by DevTools /json/list.",
    );
  }

  return targets;
}

/**
 * Pick a sensible default target from a filtered list. Prefers targets
 * whose URL is not `chrome://`, `devtools://`, or `about:blank`, then
 * falls back to the first entry. Callers that need more specific
 * control should iterate the list themselves.
 *
 * Throws `no_targets` on an empty input list — this mirrors the shape
 * of {@link listDevToolsTargets}, so callers that chain the two can
 * rely on a single error code path.
 */
export function pickDefaultTarget(targets: DevToolsTarget[]): DevToolsTarget {
  if (targets.length === 0) {
    throw new DevToolsDiscoveryError(
      "no_targets",
      "pickDefaultTarget called with an empty target list.",
    );
  }

  const preferred = targets.find((target) => !isUtilityTarget(target));
  return preferred ?? targets[0]!;
}

function isUtilityTarget(target: DevToolsTarget): boolean {
  const url = target.url.toLowerCase();
  if (url.startsWith("chrome://")) return true;
  if (url.startsWith("devtools://")) return true;
  if (url === "about:blank") return true;
  return false;
}
