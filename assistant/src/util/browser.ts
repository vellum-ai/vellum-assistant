import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "./logger.js";
import { isLinux, isMacOS } from "./platform.js";

const log = getLogger("browser");

/**
 * Open a URL on the user's host machine.
 *
 * Publishes an `open_url` event via the assistant event hub so that connected
 * native clients (e.g. the Swift macOS app) can open the browser on the
 * user's machine. Falls back to a local `open`/`xdg-open` spawn when the
 * event hub has no subscribers (standalone CLI on a developer laptop).
 */
export async function openInHostBrowser(url: string): Promise<void> {
  if (assistantEventHub.subscriberCount() > 0) {
    try {
      await assistantEventHub.publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "open_url",
          url,
        }),
      );
      return;
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to publish open_url event — falling back to local browser",
      );
    }
  }

  // Fallback: spawn the platform's default browser locally.
  if (isMacOS()) {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } else if (isLinux()) {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  } else {
    process.stderr.write(`Open this URL to authorize:\n\n${url}\n`);
  }
}
