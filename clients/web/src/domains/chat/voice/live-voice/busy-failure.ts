/**
 * Turning a refused start into something the user can act on.
 *
 * A daemon runs one live-voice session at a time, so a second start is
 * answered with `busy`. That used to surface as "Another live-voice session is
 * active." and nothing else: no device, no conversation, no action. Users
 * asked the assistant for help finding a session the UI would not point them
 * to (LUM-3421).
 *
 * The `busy` frame now carries as much as the daemon knows about the holder,
 * which is what this turns into copy plus a recovery. It is deliberately
 * separate from the session hook so the wording can be read and tested without
 * standing a session up.
 */

import type { LiveVoiceErrorRecovery } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoiceSessionHolder } from "@/domains/chat/voice/live-voice/protocol";

/**
 * Where a session is running, said the way a user would look for it, keyed by
 * the daemon's `ClientOs` vocabulary.
 *
 * "another browser tab" is the odd one out on purpose: `web` is the only value
 * that does not name a place a user can walk to, and a tab is what they will
 * actually be hunting through.
 */
const HOLDER_SURFACE_LABELS: Readonly<Record<string, string>> = {
  web: "another browser tab",
  ios: "the iOS app",
  macos: "the Mac app",
  windows: "the Windows app",
  android: "the Android app",
};

/** Copy for a holder the daemon could not place at all. */
const UNPLACEABLE_HOLDER_MESSAGE = "Voice is already active somewhere else.";

export interface BusyFailure {
  message: string;
  recovery: LiveVoiceErrorRecovery;
}

/**
 * Describe the session that refused this one, and what can be done about it.
 *
 * `currentConversationId` is the conversation the refused client is sitting
 * in. It never appears in the copy; it decides whether there is anywhere to
 * send the user, since offering to navigate to the conversation they are
 * already reading would be an action that visibly does nothing.
 *
 * The message names the device rather than the conversation because that is
 * the half a user cannot work out for themselves. Whichever conversation it is
 * in, the session is invisible from here; which machine it is on is the thing
 * that tells them where to look.
 */
export function describeBusyFailure(
  holder: LiveVoiceSessionHolder | undefined,
  currentConversationId: string | null,
): BusyFailure {
  const surface = holder?.client
    ? HOLDER_SURFACE_LABELS[holder.client]
    : undefined;
  const holderConversationId = holder?.conversationId ?? null;
  return {
    message: surface
      ? `Voice is already active in ${surface}.`
      : UNPLACEABLE_HOLDER_MESSAGE,
    recovery: {
      kind: "reclaim",
      holderConversationId:
        holderConversationId !== null &&
        holderConversationId !== currentConversationId
          ? holderConversationId
          : null,
    },
  };
}
