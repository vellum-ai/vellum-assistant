/**
 * The `visibleInSourceNow` attention hint, resolved for one producer.
 *
 * Answers "is the user already watching the conversation this notification is
 * about", which `emit-signal.ts` consumes as a hard pre-decision suppression.
 * Producers opt in by passing the conversation the notification duplicates;
 * global and infra signals with no source to watch keep passing `false`.
 *
 * Never opt in a `guardian.question` producer. The card is the prompt, so
 * suppressing it hangs the tool until prompt timeout.
 *
 * Fails open, the same posture as the presence reads in
 * `assistant-reply-producer.ts`: anything short of a confident "focused"
 * answers `false` and the notification goes out.
 */

import type pino from "pino";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { isWebConversationFocused } from "../runtime/web-presence.js";
import { getLogger } from "../util/logger.js";

const ACTIVITY_PRESENCE_FLAG = "activity-presence-suppression" as const;

const log = getLogger("notification-source-active");

export interface ResolveVisibleInSourceOptions {
  conversationId: string | undefined;
  logger?: pino.Logger;
}

/**
 * Deliberately does not consult `isDesktopAttended()`: that reads system idle
 * time, so it answers "is the user at their computer", not "is the user
 * watching this conversation".
 */
export function resolveVisibleInSourceNow(
  options: ResolveVisibleInSourceOptions,
): boolean {
  const { conversationId, logger } = options;
  if (!conversationId) {
    return false;
  }
  if (!isAssistantFeatureFlagEnabled(ACTIVITY_PRESENCE_FLAG)) {
    return false;
  }
  try {
    return isWebConversationFocused(conversationId);
  } catch (err) {
    (logger ?? log).warn(
      { err },
      "Web presence read failed; treating as unfocused",
    );
    return false;
  }
}
