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
 * **Only on an empty conversation.** The seed is not a private instruction: it
 * travels the ordinary typed-turn path, so the daemon runs it as a real user
 * utterance and persists it as a user message, permanently, exactly as a
 * spoken one. At the top of a thread with nothing else in it, that reads as
 * what it is, an opener. In a thread already underway it is a line the user
 * never wrote, appearing in their history every time they open voice, which is
 * a worse problem than the silence it answers.
 *
 * The gate also lands the behaviour where the silence hurts. A room opened on
 * an existing thread has the conversation on screen to react to; a room opened
 * on a blank one has nothing at all.
 *
 * **An instruction, not an arrival line.** The seed shows as the user either
 * way, so the choice is only about what it buys. An instruction bounds the
 * opener: without the length cap the assistant is free to deliver a paragraph
 * before the user can get a word in.
 */
export function voiceEntryGreetingSeed(
  conversationIsEmpty: boolean,
): string | undefined {
  return conversationIsEmpty ? t("chat:voiceEntryGreeting.seed") : undefined;
}
