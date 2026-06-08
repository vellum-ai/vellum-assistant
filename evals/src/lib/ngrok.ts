/**
 * Expose a local TCP port via an ngrok HTTPS tunnel.
 *
 * Used by `evals server --ngrok` so an operator can share their local
 * report-server URL with a teammate (or with their own remote machine)
 * without standing up real infra. The tunnel is one-shot: it lives
 * exactly as long as the `evals server` process and is torn down on
 * SIGINT / SIGTERM.
 *
 * Wire flow:
 *   1. We spawn `ngrok http <port> --log=stdout --log-format=logfmt`.
 *      ngrok's agent simultaneously listens on its local management API
 *      (default `http://127.0.0.1:4040`) which exposes the public URL
 *      via `GET /api/tunnels` as soon as the tunnel is up.
 *   2. We poll that endpoint until either a tunnel pointing at our
 *      port shows up, or we hit the timeout.
 *   3. The returned `stop()` kills the child and waits for it to exit.
 *
 * Operator surface is deliberately minimal: no region pinning, no custom
 * subdomains. The user is expected to have `ngrok` on PATH. If they want
 * anything beyond the random ephemeral subdomain ngrok hands out, they
 * supply an authtoken via the `NGROK_AUTHTOKEN` environment variable
 * (preferred — works headlessly and is documented in `evals/.env.example`)
 * or via `ngrok config add-authtoken` ahead of time. The `ngrok` agent
 * reads `NGROK_AUTHTOKEN` from its inherited environment at startup, so
 * no extra plumbing is needed here beyond making sure the env survives
 * the `spawn` (which it does by default — we don't override `env`).
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** Default port of ngrok's local management API. */
export const NGROK_API_PORT = 4040;

/** Default poll interval while waiting for the tunnel to come up. */
export const TUNNEL_POLL_INTERVAL_MS = 250;

/** Default total wait time before giving up. */
export const TUNNEL_POLL_TIMEOUT_MS = 15_000;

/** Handle returned to the caller. */
export interface NgrokTunnel {
  /** Public HTTPS URL the tunnel is reachable at. */
  publicUrl: string;
  /** Kill the ngrok child and wait for it to exit. Idempotent. */
  stop: () => Promise<void>;
}

interface NgrokTunnelRecord {
  public_url?: unknown;
  proto?: unknown;
  config?: { addr?: unknown } | unknown;
}

interface NgrokTunnelsResponse {
  tunnels?: NgrokTunnelRecord[];
}

/**
 * Pick the HTTPS public URL pointing at the requested local port from
 * an `/api/tunnels` response payload. Pulled out as a pure function so
 * unit tests can exercise the (surprisingly fiddly) shape-matching
 * without spawning anything.
 *
 * ngrok returns one record per tunnel; with `ngrok http <port>` we'll
 * typically see two — an `https` and an `http` record both pointing at
 * the same upstream. We prefer `https` and fall back to `http` only if
 * no https tunnel exists.
 *
 * Returns `null` when no usable tunnel is present yet (the caller polls
 * until one appears or we hit the timeout).
 */
export function pickPublicUrl(payload: unknown, port: number): string | null {
  if (!payload || typeof payload !== "object") return null;
  const tunnels = (payload as NgrokTunnelsResponse).tunnels;
  if (!Array.isArray(tunnels)) return null;

  let httpsUrl: string | null = null;
  let httpUrl: string | null = null;

  for (const t of tunnels) {
    const url = typeof t.public_url === "string" ? t.public_url : null;
    if (!url) continue;
    if (!tunnelTargetsPort(t, port)) continue;
    if (t.proto === "https" && httpsUrl === null) httpsUrl = url;
    else if (t.proto === "http" && httpUrl === null) httpUrl = url;
  }

  return httpsUrl ?? httpUrl;
}

function tunnelTargetsPort(t: NgrokTunnelRecord, port: number): boolean {
  const config = t.config;
  if (!config || typeof config !== "object") return false;
  const addr = (config as { addr?: unknown }).addr;
  if (typeof addr !== "string") return false;
  // addr can be "http://localhost:3005", "127.0.0.1:3005", or ":3005";
  // we only care about the port suffix.
  return addr.endsWith(`:${port}`);
}

/** Injection seam: test code overrides spawn + fetch. */
export interface NgrokDeps {
  spawn?: typeof spawn;
  fetch?: typeof fetch;
}

/** Tunable knobs (poll cadence, API host/port, timeout). */
export interface StartNgrokTunnelOptions {
  /** Local port to expose. */
  port: number;
  /** Override the management API host (default `127.0.0.1`). */
  apiHost?: string;
  /** Override the management API port (default `4040`). */
  apiPort?: number;
  /** How often to poll for the tunnel URL. */
  pollIntervalMs?: number;
  /** Total wait time before giving up. */
  pollTimeoutMs?: number;
  /** Test seams. Production calls leave undefined. */
  deps?: NgrokDeps;
}

/**
 * Spawn an ngrok HTTPS tunnel against the local server and wait for
 * the public URL to be available.
 *
 * Throws synchronously if `ngrok` isn't on PATH (so the caller can fail
 * fast before the server even prints "listening on"). Throws if the
 * agent exits before a tunnel URL shows up, or if we hit the poll
 * timeout.
 */
export async function startNgrokTunnel(
  opts: StartNgrokTunnelOptions,
): Promise<NgrokTunnel> {
  const spawnFn = opts.deps?.spawn ?? spawn;
  const fetchFn = opts.deps?.fetch ?? fetch;
  const apiHost = opts.apiHost ?? "127.0.0.1";
  const apiPort = opts.apiPort ?? NGROK_API_PORT;
  const pollIntervalMs = opts.pollIntervalMs ?? TUNNEL_POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? TUNNEL_POLL_TIMEOUT_MS;

  const child = spawnFn(
    "ngrok",
    ["http", String(opts.port), "--log=stdout", "--log-format=logfmt"],
    { stdio: ["ignore", "pipe", "pipe"] },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  // Drain stdout/stderr so the OS pipe buffer doesn't fill up and
  // backpressure ngrok into a stall. We never read these for control
  // flow — the management API is the source of truth — but losing
  // their contents is fine; ngrok logs to its own files too.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  // Track a definitive exit so we can surface a clear error even
  // if we're mid-poll. `code` is null on signal-kill; we report both.
  // Wrapping in an object sidesteps TS's narrowing of closure-captured
  // `let` variables back to their initial `null` type.
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  const exitState: { info: ExitInfo | null } = { info: null };
  child.on("exit", (code, signal) => {
    exitState.info = { code, signal };
  });

  const start = Date.now();
  while (Date.now() - start < pollTimeoutMs) {
    const info = exitState.info;
    if (info) {
      throw new Error(
        `ngrok exited before publishing a tunnel (code=${info.code} signal=${info.signal}). ` +
          `Common causes: missing authtoken (set NGROK_AUTHTOKEN or run \`ngrok config add-authtoken\`), ` +
          `port already tunnelled, or no internet. ` +
          `Try \`ngrok http ${opts.port}\` directly to see the agent's error.`,
      );
    }
    const url = await tryFetchPublicUrl({
      fetchFn,
      apiHost,
      apiPort,
      port: opts.port,
    });
    if (url) {
      return makeHandle(child, url);
    }
    await sleep(pollIntervalMs);
  }

  // Timed out — kill the child so we don't leak a tunnel.
  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }
  throw new Error(
    `ngrok tunnel did not come up within ${pollTimeoutMs}ms. ` +
      `Check that the agent is running and reachable at http://${apiHost}:${apiPort}.`,
  );
}

async function tryFetchPublicUrl(args: {
  fetchFn: typeof fetch;
  apiHost: string;
  apiPort: number;
  port: number;
}): Promise<string | null> {
  try {
    const res = await args.fetchFn(
      `http://${args.apiHost}:${args.apiPort}/api/tunnels`,
    );
    if (!res.ok) return null;
    const payload = await res.json();
    return pickPublicUrl(payload, args.port);
  } catch {
    // The agent's API isn't up yet, the socket is refused, the
    // response was malformed — all "not ready yet, keep polling".
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHandle(
  child: ChildProcessByStdio<null, Readable, Readable>,
  publicUrl: string,
): NgrokTunnel {
  let stopped = false;
  return {
    publicUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const onExit = (): void => resolve();
        child.once("exit", onExit);
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
          child.off("exit", onExit);
          resolve();
        }
      });
    },
  };
}
