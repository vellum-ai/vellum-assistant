/**
 * Whether a live-voice entry opens with the assistant speaking, and what it
 * says to get there (JARVIS-1649).
 *
 * A voice room that opens silent puts the burden of the first move on the
 * user, who has just pressed a button and is now looking at an animation
 * waiting for them. The fix is to take a turn on their behalf the moment the
 * session is ready, which the typed-turn frame (JARVIS-1522) already makes
 * possible without a daemon change.
 *
 * The rule and the copy live together, in one module, because they are not
 * separable: the copy is only honest under the rule.
 */

import { t } from "@/i18n";

/**
 * The seed turn for a voice entry, or `undefined` to open silent.
 *
 * **Only on an empty conversation.** The seed is not a private instruction:
 * it travels the ordinary typed-turn path, so the daemon runs it as a real
 * user utterance and persists it as a user message, permanently, exactly as a
 * spoken one. At the top of a thread with nothing else in it, that reads as
 * what it is, an opener. Sent into a thread already underway it is a line the
 * user never wrote, appearing in their history every time they happen to open
 * voice, which is a worse problem than the silence it fixes.
 *
 * That gate also lands the behaviour where the silence actually hurts. A room
 * opened on an existing thread has the conversation on screen to react to; a
 * room opened on a blank one has nothing at all.
 *
 * **Why an instruction rather than an arrival line.** Since the seed is shown
 * as the user either way, the choice is only about what it buys. An
 * instruction bounds the opener: without the length cap the assistant is free
 * to deliver a paragraph before the user can get a word in, which is the exact
 * way a greeting on every entry stops being welcome.
 */
export function voiceEntryGreetingSeed(
  conversationIsEmpty: boolean,
): string | undefined {
  return conversationIsEmpty ? t("chat:voiceEntryGreeting.seed") : undefined;
}
