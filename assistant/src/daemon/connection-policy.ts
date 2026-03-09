/**
 * Connection policy helpers for daemon autostart and authentication behavior.
 *
 * Token authentication is always required.
 * To explicitly disable auth (e.g. development/testing scenarios),
 * set VELLUM_DAEMON_NOAUTH=1 on both the daemon and the client.
 * This is an intentional opt-in to an unsafe mode — never enable it
 * on connections accessible to untrusted users.
 */

/**
 * True when the user has explicitly opted into unauthenticated connections
 * via VELLUM_DAEMON_NOAUTH=1.
 *
 * Requires VELLUM_UNSAFE_AUTH_BYPASS=1 as a safety gate to prevent
 * accidental production use.
 */
export function hasNoAuthOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.VELLUM_DAEMON_NOAUTH?.trim();
  if (value !== "1" && value !== "true") return false;

  const safetyGate = env.VELLUM_UNSAFE_AUTH_BYPASS?.trim();
  if (safetyGate !== "1") return false;

  return true;
}

/**
 * True when VELLUM_DAEMON_NOAUTH is set but the safety gate
 * VELLUM_UNSAFE_AUTH_BYPASS=1 is missing — used for warning messages.
 */
export function hasUngatedNoAuthOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.VELLUM_DAEMON_NOAUTH?.trim();
  if (value !== "1" && value !== "true") return false;

  const safetyGate = env.VELLUM_UNSAFE_AUTH_BYPASS?.trim();
  return safetyGate !== "1";
}

export function shouldAutoStartDaemon(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Explicit autostart flag takes precedence
  const autostart = env.VELLUM_DAEMON_AUTOSTART?.trim();
  if (autostart === "1" || autostart === "true") return true;
  if (autostart === "0" || autostart === "false") return false;

  // Default: autostart enabled
  return true;
}
