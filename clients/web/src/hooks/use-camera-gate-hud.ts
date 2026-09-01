/**
 * Who may reach the camera frame gate's tuning readout.
 *
 * Two gates, and the flag is not redundant with the staff check. A local
 * gateway session has no platform identity and is never staff, and a local
 * session is exactly where the gate gets tuned: a developer with a webcam and
 * a dev server. The flag is what lets that session in without widening who
 * counts as staff.
 */

import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { isVellumStaff } from "@/lib/auth/staff";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Whether this session may turn the readout on at all. The settings toggle
 * gates its own visibility on this, so a session that can never see the panel
 * is not offered a switch for it.
 */
export function useCameraGateHudAvailable(): boolean {
  const user = useAuthStore.use.user();
  const flagged = useClientFeatureFlagStore.use.cameraGateDebugHud();
  return isVellumStaff(user) || flagged === true;
}

/** Whether the panel should be collecting and on screen. */
export function useCameraGateHudEnabled(): boolean {
  const available = useCameraGateHudAvailable();
  const hudEnabled = useCameraGateDebugStore.use.hudEnabled();
  return available && hudEnabled;
}
