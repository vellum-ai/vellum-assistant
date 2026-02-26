import type { HandlerContext } from './shared.js';
import { log } from './shared.js';

/**
 * Send a client_settings_update message to all connected clients.
 * Used to push configuration changes (e.g. activation key) from the daemon
 * to macOS/iOS clients so they can apply settings immediately.
 */
export function broadcastClientSettingsUpdate(
  key: string,
  value: string,
  ctx: HandlerContext,
): void {
  ctx.broadcast({
    type: 'client_settings_update',
    key,
    value,
  });
  log.info({ key, value }, 'Broadcast client_settings_update');
}
