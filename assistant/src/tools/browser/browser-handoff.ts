import type { ServerMessage } from '../../daemon/ipc-contract.js';
import { getLogger } from '../../util/logger.js';
import { browserManager } from './browser-manager.js';
import { isScreencastActive } from './browser-screencast.js';

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

  // Bring Chrome to the front so the user can interact directly.
  // The window is already sized/positioned in top-right via positionWindowSidebar(),
  // so no repositioning needed.
  if (options.bringToFront) {
    try {
      const page = await browserManager.getOrCreateSessionPage(sessionId);
      await page.bringToFront();
    } catch (err) {
      log.warn({ err, sessionId }, 'Failed to bring browser to front');
    }
  }

  if (!isScreencastActive(sessionId)) {
    log.warn({ sessionId }, 'No active browser session for handoff');
    return;
  }

  // Send interactive mode change with reason and message.
  // surfaceId uses sessionId as a stable identifier since PiP surfaces are removed.
  sendToClient({
    type: 'browser_interactive_mode_changed',
    sessionId,
    surfaceId: sessionId,
    enabled: true,
    reason: options.reason,
    message: options.message,
  } as ServerMessage);

  browserManager.setInteractiveMode(sessionId, true);

  // Wait for user to hand back control (5 min timeout, or auto-detect URL change)
  await browserManager.waitForHandoffComplete(sessionId);

  sendToClient({
    type: 'browser_interactive_mode_changed',
    sessionId,
    surfaceId: sessionId,
    enabled: false,
  } as ServerMessage);

  log.info({ sessionId }, 'Handoff complete, agent resuming');
}
