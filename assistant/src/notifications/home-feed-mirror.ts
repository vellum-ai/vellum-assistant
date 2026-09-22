import { isBackgroundConversationType } from "../persistence/conversation-types.js";
import { readChannelAllowlist } from "./channel-allowlist.js";
import type { NotificationSignal } from "./signal.js";

/**
 * Whether the home feed carries a card for `signal`, judged from the signal
 * and the conversation it names. The feed side effect's mirror decision is
 * this plus two checks only it can make (a guardian request always mirrors;
 * a delivery that materialized an assistant-initiated thread never does).
 *
 * The one other reader is the passive vellum append: a notification the
 * bell carries is bookkeeping about the conversation it is appended to, so
 * that append must not resurface a Done chat, while a notification the bell
 * does not carry has the transcript as its only home and must.
 *
 * `assistant_tool` mirrors unconditionally because the documented
 * `notifications send` skill (and background-job failure emits) deliberately
 * target the home feed, unless an exclusive channel allowlist leaves vellum
 * out; `chat.assistant_reply` follows the same rule. An async-background
 * hint or a background-typed source conversation mirrors as well.
 */
export function signalMirrorsToHomeFeed(
  signal: NotificationSignal,
  sourceConversationType: string | undefined,
): boolean {
  if (
    signal.sourceChannel === "assistant_tool" ||
    signal.sourceEventName === "chat.assistant_reply"
  ) {
    const allowlist = readChannelAllowlist(signal.contextPayload);
    if (!allowlist || allowlist.includes("vellum")) {
      return true;
    }
  }
  if (signal.attentionHints.isAsyncBackground) {
    return true;
  }
  return isBackgroundConversationType(sourceConversationType);
}
