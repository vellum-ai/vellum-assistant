/**
 * Wire contract between the daemon (client) and the route host subprocess
 * (server), carried over the shared IPC framing (`ipc/ipc-framing.ts`) on the
 * Unix socket at `$VELLUM_WORKSPACE_DIR/procs/routes/routes.sock`.
 *
 * One request/response pair per route invocation, correlated by the envelope
 * `id`. Request/response **bodies** are not embedded in the JSON envelope —
 * they travel as the single binary follow-frame the framing already supports
 * (`content-length` header + one binary frame), so a body is streamed as bytes
 * rather than base64'd through JSON.
 */

/** Subprocess name → its `procs/<name>/` runtime dir, socket, and PID file. */
export const ROUTE_HOST_PROC_NAME = "routes";

/** The one IPC method the route host serves. */
export const ROUTE_INVOKE_METHOD = "invoke";

/**
 * Request metadata (daemon → host). The resolved handler file is passed in —
 * the daemon does path resolution and 404s, so the host never touches route
 * resolution and never runs for an unknown path. The request body, if any,
 * rides in the binary follow-frame.
 */
export interface RouteInvokeParams {
  /** Absolute path to the resolved handler module. */
  readonly filePath: string;
  /** The handler file's mtime (ms) — the host's import cache-buster. */
  readonly mtimeMs: number;
  /** HTTP method whose exported handler should run. */
  readonly method: string;
  /** Full synthetic request URL (`http://localhost/v1/x/<path>?<query>`). */
  readonly url: string;
  /** Request header entries as `[name, value]` pairs (preserves duplicates). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/**
 * Response metadata (host → daemon). The response body, if any, rides in the
 * binary follow-frame. On a handler throw / load failure the host replies with
 * the envelope's `error` field instead, which the daemon maps to a 500.
 */
export interface RouteInvokeResult {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}
