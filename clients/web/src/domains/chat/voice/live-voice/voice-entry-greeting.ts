/**
 * Whether a live-voice entry opens with the assistant speaking, and what it
 * says to get there.
 *
 * A voice room that opens silent leaves the first move to the user, who has
 * just pressed a button and is now watching an animation wait for them. A seed
 * turn takes that move on their behalf.
 *
 * The rule and the copy live together, in one module, because they are not
 * separable: the copy is only honest under the rule.
 */

import { t } from "@/i18n";

/**
 * The seed turn for a voice entry, or `undefined` to open silent.
 *
 * **Only on an empty conversation.** The seed travels as a hidden turn, so on
 * a current assistant it drives the reply without ever rendering. An assistant
 * too old to understand `hidden` persists it as an ordinary user message
 * instead, and that message is permanent. At the top of an otherwise empty
 * thread it reads as an opener; in a thread already underway it is a line the
 * user never wrote, appearing every time they open voice, which is a worse
 * problem than the silence it answers. The gate is what keeps the degraded
 * case tolerable.
 *
 * The gate also lands the behaviour where the silence hurts. A room opened on
 * an existing thread has the conversation on screen to react to; a room opened
 * on a blank one has nothing at all.
 *
 * **The copy says what it is, then what it wants.** It names itself as
 * automatic, so the degraded case reads as a machine message rather than words
 * put in the user's mouth, and it tells the model the same thing. The length
 * cap is the rest of it: without one the assistant is free to deliver a
 * paragraph before the user can get a word in.
 */
export function voiceEntryGreetingSeed(
  conversationIsEmpty: boolean,
): string | undefined {
  return conversationIsEmpty ? t("chat:voiceEntryGreeting.seed") : undefined;
}
