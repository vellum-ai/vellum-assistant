import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { INTERRUPT_ON_SEND_FLAG_KEY } from "./interrupt-on-send-flag.js";
import type { AssistantConfig } from "./schema.js";

/**
 * Whether a message sent while the assistant is busy interrupts the running
 * turn instead of queueing behind it.
 *
 * On, the message aborts the in-flight tool call or model stream, the
 * abandoned tool calls get a synthetic result, and the message starts its own
 * turn at once. Off, it goes on the conversation's queue and runs when the
 * current turn finishes.
 *
 * Scope `both`: the daemon changes what a busy send does, and the web composer
 * stops offering Stop where Send now belongs, so both sides read one key.
 */
export function isInterruptOnSendEnabled(config?: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(INTERRUPT_ON_SEND_FLAG_KEY, config);
}
