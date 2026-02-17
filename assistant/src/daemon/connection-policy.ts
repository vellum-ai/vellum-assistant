/**
 * Connection policy helpers for daemon autostart and authentication behavior.
 *
 * When the user targets a remote/forwarded socket via VELLUM_DAEMON_SOCKET,
 * autostart should be disabled by default to avoid accidentally spawning
 * a local daemon. VELLUM_DAEMON_AUTOSTART=1 forces autostart regardless.
 *
 * Token authentication is always required, even with a socket override.
 * To explicitly disable auth (e.g. SSH-forwarded sockets where the client
 * can't read the remote token file), set VELLUM_DAEMON_NOAUTH=1 on both
 * the daemon and the client. This is an intentional opt-in to an unsafe
 * mode — never enable it on sockets accessible to untrusted users.
 */

export function hasSocketOverride(env: Record<string, string | undefined> = process.env): boolean {
  const override = env.VELLUM_DAEMON_SOCKET?.trim();
  return !!override;
}

/**
 * True when the user has explicitly opted into unauthenticated connections
 * via VELLUM_DAEMON_NOAUTH=1. This is separate from the socket override
 * so that using a custom socket path alone does NOT bypass token auth.
 */
export function hasNoAuthOverride(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.VELLUM_DAEMON_NOAUTH?.trim();
  return value === '1' || value === 'true';
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
