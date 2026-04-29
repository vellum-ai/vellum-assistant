/**
 * Handle cancel-generation signals delivered via signal files from the CLI.
 *
 * The built-in CLI writes JSON to `signals/cancel` instead of making an
 * HTTP POST to `/v1/conversations/:id/cancel`. The daemon's ConfigWatcher
 * detects the file change and invokes {@link handleCancelSignal}, which
 * reads the payload and aborts the target conversation.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import {
  findConversation,
  touchConversation,
} from "../daemon/conversation-store.js";
import { getSubagentManager } from "../subagent/index.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:cancel");

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read the `signals/cancel` file and abort the target conversation.
 * Called by ConfigWatcher when the signal file is written or modified.
 */
export function handleCancelSignal(): void {
  if (getIsContainerized()) return;

  try {
    const content = readFileSync(join(getSignalsDir(), "cancel"), "utf-8");
    const parsed = JSON.parse(content) as { conversationId?: string };
    const { conversationId } = parsed;

    if (!conversationId || typeof conversationId !== "string") {
      log.warn("Cancel signal missing conversationId");
      return;
    }

    const conversation = findConversation(conversationId);
    if (!conversation) {
      log.warn({ conversationId }, "No active conversation for cancel signal");
      return;
    }

    touchConversation(conversationId);
    conversation.abort(
      createAbortReason("signal_cancel", "handleCancelSignal", conversationId),
    );
    getSubagentManager().abortAllForParent(conversationId);

    log.info({ conversationId }, "Generation cancelled via signal file");
  } catch (err) {
    log.error({ err }, "Failed to handle cancel signal");
  }
}
