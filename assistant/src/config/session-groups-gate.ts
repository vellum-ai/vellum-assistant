import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";

export const SESSION_GROUPS_FLAG_KEY = "session-groups";

let recoveryHealthy = true;

/** Recovery is a process prerequisite, independent of rollout targeting. */
export function setModeSessionRecoveryHealthy(healthy: boolean): void {
  recoveryHealthy = healthy;
}

export function isModeSessionRecoveryHealthy(): boolean {
  return recoveryHealthy;
}

/** Whether this assistant may admit new transcript mode-session tracking. */
export function isSessionGroupsEnabled(): boolean {
  return (
    recoveryHealthy && isAssistantFeatureFlagEnabled(SESSION_GROUPS_FLAG_KEY)
  );
}
