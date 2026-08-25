/**
 * The copy and the recovery behind a refused live-voice start.
 *
 * An assistant runs one live-voice session at a time and answers a second
 * start with `busy`, carrying what it knows about the session holding the
 * slot. This turns that into the message a surface shows and the action it
 * offers.
 *
 * A plain function rather than part of the session hook, so the wording can be
 * read and tested without standing a session up.
 */

import type { LiveVoiceErrorRecovery } from "@/domains/chat/voice/live-voice/live-voice-store";
import type { LiveVoiceSessionHolder } from "@/domains/chat/voice/live-voice/protocol";
import { fixedT, type ParseKeys } from "@/i18n";

/**
 * One whole sentence per surface, keyed by the assistant's `ClientOs`
 * vocabulary. Whole sentences rather than a name interpolated into a frame:
 * the surrounding words inflect with the noun in the languages this ships in.
 */
const HOLDER_MESSAGE_KEYS: Readonly<Record<string, ParseKeys<"chat">>> = {
  web: "liveVoiceBusy.web",
  ios: "liveVoiceBusy.ios",
  macos: "liveVoiceBusy.macos",
  windows: "liveVoiceBusy.windows",
  android: "liveVoiceBusy.android",
};

/** Copy for a holder that named no surface this build recognizes. */
const UNPLACEABLE_HOLDER_KEY: ParseKeys<"chat"> = "liveVoiceBusy.unknown";

export interface BusyFailure {
  message: string;
  recovery: LiveVoiceErrorRecovery;
}

/**
 * Describe the session that refused this one, and what can be done about it.
 *
 * `currentConversationId` is the conversation the refused client sits in. It
 * never appears in the copy; it decides whether there is anywhere to send the
 * user, since offering to navigate to the conversation they are already
 * reading would be an action that visibly does nothing.
 *
 * The message names the device rather than the conversation because that is
 * the half a user cannot work out for themselves. Whichever conversation it is
 * in, the session is invisible from here; which machine it is on is what tells
 * them where to look.
 *
 * Reads copy through the non-reactive `t`: this answers a transport frame in
 * an event handler and writes a string into the store, which is the call shape
 * `@/i18n` documents it for. A locale switch between the failure and its
 * dismissal leaves the message in the previous language.
 */
export function describeBusyFailure(
  holder: LiveVoiceSessionHolder | undefined,
  currentConversationId: string | null,
): BusyFailure {
  const t = fixedT("chat");
  const messageKey = holder?.client
    ? HOLDER_MESSAGE_KEYS[holder.client]
    : undefined;
  const holderConversationId = holder?.conversationId ?? null;
  return {
    message: t(messageKey ?? UNPLACEABLE_HOLDER_KEY),
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
