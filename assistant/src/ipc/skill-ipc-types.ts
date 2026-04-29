/** Shared types for the skill IPC layer (skill-server + skill-routes). */

/** Handler shape for skill IPC routes — receives flat params + connection. */
export type SkillMethodHandler = (
  params?: Record<string, unknown>,
  connection?: unknown,
) => unknown | Promise<unknown>;

/** A single skill IPC route — method name + handler. */
export type SkillIpcRoute = {
  method: string;
  handler: SkillMethodHandler;
};

// ---------------------------------------------------------------------------
// Streaming types
// ---------------------------------------------------------------------------

export interface SkillIpcStream {
  /** The original request id that opened this stream (used as the stream id). */
  readonly id: string;
  /**
   * Send a delivery frame to the client. No-op after the stream has been
   * closed (client disconnect, explicit close, or server shutdown).
   */
  send(payload: unknown): void;
  /**
   * Terminate the stream from the server side. Sends a final error frame to
   * the client (if `errorMessage` is provided and the socket is still
   * writable), invokes the handler-returned dispose, and unregisters the
   * stream from the per-socket subscription map. Idempotent — subsequent
   * calls are no-ops.
   */
  close(errorMessage?: string): void;
  /** True until the stream has been disposed. */
  readonly active: boolean;
}

/**
 * Handler signature for long-lived streaming methods (e.g.
 * `host.events.subscribe`). Runs synchronously with the opening request and
 * returns a dispose callback that the server invokes on client disconnect,
 * explicit close, or server shutdown.
 */
export type SkillIpcStreamingHandler = (
  stream: SkillIpcStream,
  params?: Record<string, unknown>,
) => () => void;

/** Long-lived streaming route — method name + handler function. */
export type SkillIpcStreamingRoute = {
  method: string;
  handler: SkillIpcStreamingHandler;
};
