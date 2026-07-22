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

import { LiveVoiceSessionManager } from "./live-voice-session-manager.js";

const require = createRequire(import.meta.url);

let manager: LiveVoiceSessionManager | null = null;

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
        const { createLiveVoiceSession } =
          require("./live-voice-session.js") as typeof import("./live-voice-session.js");
        return createLiveVoiceSession(context);
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
