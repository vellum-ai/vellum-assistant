/**
 * Message protocol shared between the user-route worker pool (main thread,
 * `user-route-worker-pool.ts`) and the worker entry (`user-route-worker-entry.ts`).
 *
 * This module is **type-only** on purpose: the worker entry imports it with
 * `import type`, so nothing here runs inside the worker and no daemon module is
 * dragged into the worker's isolate. Keep it free of runtime values.
 *
 * Wire shapes are structured-clone-friendly — plain objects, arrays, and
 * `ArrayBuffer` bodies — because everything crosses the `postMessage` boundary
 * between threads. `Request`/`Response` are deliberately NOT sent across the
 * boundary (their bodies are streams and don't clone); the pool marshals a
 * request down to {@link SerializedRequest} and the worker marshals the
 * handler's `Response` back up to {@link SerializedResponse}. `ArrayBuffer` is
 * used for bodies (not `Uint8Array`) because it is directly a valid `BodyInit`
 * for reconstructing `Request`/`Response`.
 */

/** A request reduced to clonable parts, reconstructed into a `Request` in the worker. */
export interface SerializedRequest {
  /** Absolute synthetic URL (`http://localhost/v1/x/<path>?<query>`). */
  readonly url: string;
  readonly method: string;
  /** Header entries as `[name, value]` pairs (preserves duplicates). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Raw request body, or `null` for bodyless methods (GET/HEAD) and empty bodies. */
  readonly body: ArrayBuffer | null;
}

/** A handler `Response` reduced to clonable parts, reconstructed on the main thread. */
export interface SerializedResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Fully-buffered response body, or `null` for empty/no-content responses. */
  readonly body: ArrayBuffer | null;
}

/** Context methods the worker can call back into the main thread over RPC. */
export type ContextCallMethod = "publish" | "postMessage";

// --- Main thread → worker -------------------------------------------------

/** Run a handler file for one HTTP request. */
export interface JobMessage {
  readonly type: "job";
  readonly jobId: number;
  /** Absolute path to the resolved handler module. */
  readonly filePath: string;
  /** The file's mtime (ms) at resolution time — the worker's import cache-buster. */
  readonly mtimeMs: number;
  /** The HTTP method whose exported handler should run. */
  readonly method: string;
  readonly request: SerializedRequest;
}

/** The main thread's answer to a worker's context call. */
export interface ContextResultMessage {
  readonly type: "ctx-result";
  readonly callId: number;
  readonly ok: boolean;
  /** Present when `ok`. Must be structured-clone-friendly. */
  readonly value?: unknown;
  /** Present when `!ok`. `code` carries `RouteMessageError.code` for handler catch blocks. */
  readonly error?: { readonly message: string; readonly code?: string };
}

export type WorkerInbound = JobMessage | ContextResultMessage;

// --- Worker → main thread -------------------------------------------------

/** The handler ran (or 405'd) and produced a response. */
export interface JobResultMessage {
  readonly type: "result";
  readonly jobId: number;
  readonly response: SerializedResponse;
}

/** The handler threw (or the module failed to load). Mapped to a 500 by the pool. */
export interface JobErrorMessage {
  readonly type: "error";
  readonly jobId: number;
  readonly error: { readonly message: string };
}

/** A handler invoked a `context` method; the main thread services it and replies. */
export interface ContextCallMessage {
  readonly type: "ctx-call";
  readonly callId: number;
  readonly method: ContextCallMethod;
  /** Positional args, structured-clone-friendly. */
  readonly args: readonly unknown[];
}

export type WorkerOutbound =
  | JobResultMessage
  | JobErrorMessage
  | ContextCallMessage;
