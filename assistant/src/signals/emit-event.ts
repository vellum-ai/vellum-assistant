/**
 * Handle generic event signals from the CLI.
 *
 * When the CLI writes a JSON-encoded {@link ServerMessage} to
 * `signals/emit-event`, the daemon's ConfigWatcher detects the file
 * change and invokes {@link handleEmitEventSignal}, which reads the
 * payload and publishes it to connected clients via the in-process
 * {@link assistantEventHub}.
 *
 * This provides a general-purpose CLI→daemon event bridge so that any
 * CLI command can place arbitrary events onto the hub without needing
 * a dedicated signal handler per event type.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:emit-event");

export function handleEmitEventSignal(): void {
  try {
    const content = readFileSync(join(getSignalsDir(), "emit-event"), "utf-8");
    const message = JSON.parse(content) as ServerMessage;

    assistantEventHub
      .publish(buildAssistantEvent(message))
      .catch((err: unknown) => {
        log.error({ err }, "Failed to publish event from signal");
      });

    log.info({ type: message.type }, "Emit-event signal handled");
  } catch (err) {
    log.error({ err }, "Failed to handle emit-event signal");
  }
}
