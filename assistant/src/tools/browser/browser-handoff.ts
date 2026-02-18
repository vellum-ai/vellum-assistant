import { getLogger } from '../../util/logger.js';
import { browserManager } from './browser-manager.js';
import { getScreencastSurfaceId } from './browser-screencast.js';
import type { ServerMessage } from '../../daemon/ipc-contract.js';

const log = getLogger('browser-handoff');

export interface HandoffOptions {
  reason: 'auth' | 'checkout' | 'captcha' | 'custom';
  message: string;
  bringToFront?: boolean;
}

/**
 * Hand control to the user by enabling interactive mode and waiting for them to finish.
 */
export async function startHandoff(
  sessionId: string,
  sendToClient: (msg: ServerMessage) => void,
  options: HandoffOptions,
): Promise<void> {
  // In headless mode there's no visible browser for the user to interact with
  if (browserManager.browserMode === 'headless') {
    log.info({ sessionId, reason: options.reason }, 'Skipping handoff in headless mode — no visible browser');
    return;
  }

  log.info({ sessionId, reason: options.reason }, 'Starting handoff to user');

  const surfaceId = getScreencastSurfaceId(sessionId);
  if (!surfaceId) {
    log.warn({ sessionId }, 'No active screencast surface for handoff');
    return;
  }

  // Send interactive mode change with reason and message
  sendToClient({
    type: 'browser_interactive_mode_changed',
    sessionId,
    surfaceId,
    enabled: true,
    reason: options.reason,
    message: options.message,
  } as ServerMessage);

  browserManager.setInteractiveMode(sessionId, true);

  // Wait for user to hand back control (5 min timeout)
  await browserManager.waitForHandoffComplete(sessionId);

  sendToClient({
    type: 'browser_interactive_mode_changed',
    sessionId,
    surfaceId,
    enabled: false,
  } as ServerMessage);

  log.info({ sessionId }, 'Handoff complete, agent resuming');
}
