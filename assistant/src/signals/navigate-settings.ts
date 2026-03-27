/**
 * Handle navigate-settings signals from the CLI.
 *
 * When the CLI writes JSON to `signals/navigate-settings`, the daemon's
 * ConfigWatcher detects the file change and invokes
 * {@link handleNavigateSettingsSignal}, which reads the payload and
 * publishes a `navigate_settings` event to connected clients via the
 * in-process {@link assistantEventHub}.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:navigate-settings");

export function handleNavigateSettingsSignal(): void {
  try {
    const content = readFileSync(
      join(getSignalsDir(), "navigate-settings"),
      "utf-8",
    );
    const parsed = JSON.parse(content) as { tab?: string };
    const tab = parsed.tab ?? "General";

    assistantEventHub
      .publish(
        buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, {
          type: "navigate_settings",
          tab,
        }),
      )
      .catch((err: unknown) => {
        log.error({ err }, "Failed to publish navigate_settings event");
      });

    log.info({ tab }, "Navigate-settings signal handled");
  } catch (err) {
    log.error({ err }, "Failed to handle navigate-settings signal");
  }
}
