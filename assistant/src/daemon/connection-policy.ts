/**
 * Connection policy helpers for daemon autostart behavior.
 *
 * When the user targets a remote/forwarded socket via VELLUM_DAEMON_SOCKET,
 * autostart should be disabled by default to avoid accidentally spawning
 * a local daemon. VELLUM_DAEMON_AUTOSTART=1 forces autostart regardless.
 */

export function hasSocketOverride(env: Record<string, string | undefined> = process.env): boolean {
  const override = env.VELLUM_DAEMON_SOCKET?.trim();
  return !!override;
}

export function shouldAutoStartDaemon(env: Record<string, string | undefined> = process.env): boolean {
  // Explicit autostart flag takes precedence
  const autostart = env.VELLUM_DAEMON_AUTOSTART?.trim();
  if (autostart === '1' || autostart === 'true') return true;
  if (autostart === '0' || autostart === 'false') return false;

  // No explicit flag: disable autostart when using a remote/custom socket
  if (hasSocketOverride(env)) return false;

  // Default: autostart enabled
  return true;
}
