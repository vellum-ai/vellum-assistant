/**
 * Process-wide {@link LiveVoiceSessionManager} accessor.
 *
 * Live voice enforces a single active session per daemon (the mic is a
 * shared, exclusive resource), so the manager is a singleton rather than a
 * per-transport instance. Every entry point that drives live voice — the
 * runtime HTTP WebSocket and any plugin bringing its own transport via
 * {@link createLiveVoiceConnection} — resolves the same manager here, so they
 * share one busy lock instead of racing for the mic.
 */

import { createRequire } from "node:module";

import { getLogger } from "../util/logger.js";
import { LiveVoiceSessionManager } from "./live-voice-session-manager.js";

const require = createRequire(import.meta.url);

const log = getLogger("live-voice-manager");

type LiveVoiceSessionFactory =
  typeof import("./live-voice-session.js").createLiveVoiceSession;

let manager: LiveVoiceSessionManager | null = null;
let bundledSessionFactory: LiveVoiceSessionFactory | null = null;

export function setBundledLiveVoiceSessionFactory(
  factory: LiveVoiceSessionFactory | null,
): void {
  bundledSessionFactory = factory;
}

/**
 * The daemon-wide live voice session manager, lazily constructed on first
 * use. Sessions are produced by `createLiveVoiceSession`.
 */
export function getLiveVoiceSessionManager(): LiveVoiceSessionManager {
  if (manager === null) {
    manager = new LiveVoiceSessionManager({
      // `live-voice-session` is loaded lazily, on first session creation,
      // rather than statically imported. It drags in a large graph (subagent
      // manager, providers, persistence), and this module is reachable from
      // `@vellumai/plugin-api` via the connection factory — a static edge
      // would pull that whole graph into every plugin-api consumer at
      // module-load time. `require` keeps the factory synchronous, so the
      // manager still claims its single-session slot without an await gap.
      createSession: (context) => {
        const createSession =
          bundledSessionFactory ??
          (
            require("./live-voice-session.js") as typeof import("./live-voice-session.js")
          ).createLiveVoiceSession;
        return createSession(context);
      },
      // The manager reclaims a slot on its own only when a session stopped
      // behaving: either its teardown overran the close budget, or its client
      // went silent on a mode that streams continuously. Both end somebody's
      // call without them asking, and neither leaves a trace anywhere else, so
      // they are logged at warn.
      onSlotEvent: (event) => {
        if (event.kind === "close_timed_out") {
          log.warn(
            {
              sessionId: event.sessionId,
              reason: event.reason,
              timeoutMs: event.timeoutMs,
            },
            "Live voice session close overran its budget, freeing the slot anyway",
          );
          return;
        }
        log.warn(
          { sessionId: event.sessionId, timeoutMs: event.timeoutMs },
          "Live voice client went silent, releasing the session",
        );
      },
    });
  }
  return manager;
}

/**
 * Override (or clear, with `null`) the singleton so a test can drive
 * {@link createLiveVoiceConnection} against a manager wired to fake sessions.
 * Test-only.
 */
export function setLiveVoiceSessionManagerForTesting(
  override: LiveVoiceSessionManager | null,
): void {
  manager = override;
}
