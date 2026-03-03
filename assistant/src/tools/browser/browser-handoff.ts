import { getLogger } from "../../util/logger.js";
import { browserManager } from "./browser-manager.js";
import { isScreencastActive } from "./browser-screencast.js";

const log = getLogger("browser-handoff");

export interface HandoffOptions {
  reason: "auth" | "checkout" | "captcha" | "custom";
  message: string;
  bringToFront?: boolean;
}

/**
 * Hand control to the user by enabling interactive mode and waiting for them to finish.
 * The browser window is brought to the front, and we wait for the user to complete
 * the action (detected via URL change) or a 5-minute timeout.
 */
export async function startHandoff(
  sessionId: string,
  options: HandoffOptions,
): Promise<void> {
  log.info({ sessionId, reason: options.reason }, "Starting handoff to user");

  // Bring Chrome to the front so the user can interact directly.
  if (options.bringToFront) {
    try {
      const page = await browserManager.getOrCreateSessionPage(sessionId);
      await page.bringToFront();
    } catch (err) {
      log.warn({ err, sessionId }, "Failed to bring browser to front");
    }
  }

  if (!isScreencastActive(sessionId)) {
    log.warn({ sessionId }, "No active browser session for handoff");
    return;
  }

  browserManager.setInteractiveMode(sessionId, true);

  // Wait for user to hand back control (5 min timeout, or auto-detect URL change)
  await browserManager.waitForHandoffComplete(sessionId);

  log.info({ sessionId }, "Handoff complete, agent resuming");
}
