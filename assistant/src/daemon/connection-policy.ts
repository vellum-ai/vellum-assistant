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
 */
export function hasNoAuthOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.VELLUM_DAEMON_NOAUTH?.trim();
  return value === "1" || value === "true";
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
