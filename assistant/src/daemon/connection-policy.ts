/**
 * Connection policy helpers for daemon autostart behavior.
 */

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
