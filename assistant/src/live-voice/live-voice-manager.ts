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

import { createLiveVoiceSession } from "./live-voice-session.js";
import { LiveVoiceSessionManager } from "./live-voice-session-manager.js";

let manager: LiveVoiceSessionManager | null = null;

/**
 * The daemon-wide live voice session manager, lazily constructed on first
 * use. Sessions are produced by {@link createLiveVoiceSession}.
 */
export function getLiveVoiceSessionManager(): LiveVoiceSessionManager {
  if (manager === null) {
    manager = new LiveVoiceSessionManager({
      createSession: (context) => createLiveVoiceSession(context),
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
