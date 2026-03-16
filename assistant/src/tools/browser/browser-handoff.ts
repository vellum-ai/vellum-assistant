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
  conversationId: string,
  options: HandoffOptions,
): Promise<void> {
  log.info(
    { conversationId, reason: options.reason },
    "Starting handoff to user",
  );

  // Bring Chrome to the front so the user can interact directly.
  if (options.bringToFront) {
    try {
      const page = await browserManager.getOrCreateSessionPage(conversationId);
      await page.bringToFront();
    } catch (err) {
      log.warn({ err, conversationId }, "Failed to bring browser to front");
    }
  }

  if (!isScreencastActive(conversationId)) {
    log.warn({ conversationId }, "No active browser page for handoff");
    return;
  }

  browserManager.setInteractiveMode(conversationId, true);

  // Wait for user to hand back control (5 min timeout, or auto-detect URL change)
  await browserManager.waitForHandoffComplete(conversationId);

  log.info({ conversationId }, "Handoff complete, agent resuming");
}
