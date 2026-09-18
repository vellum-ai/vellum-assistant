import { setModeSessionRecoveryHealthy } from "../config/session-groups-gate.js";
import { recoverActiveConversationModeSessions } from "../persistence/conversation-mode-sessions.js";
import { setDbReady } from "./daemon-readiness.js";

export type ModeSessionStartupRecoveryResult =
  | { ok: true; interruptedCount: number }
  | { ok: false; error: unknown };

/** Runs after migrations; auxiliary recovery failure disables tracking for this boot. */
export function recoverModeSessionsBeforeDbReady(
  recover: () => number = recoverActiveConversationModeSessions,
): ModeSessionStartupRecoveryResult {
  try {
    const interruptedCount = recover();
    setModeSessionRecoveryHealthy(true);
    return { ok: true, interruptedCount };
  } catch (error) {
    setModeSessionRecoveryHealthy(false);
    return { ok: false, error };
  } finally {
    setDbReady(true);
  }
}
