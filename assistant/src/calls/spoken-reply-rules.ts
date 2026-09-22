/**
 * Model-facing rules for any reply that is synthesized to speech. Shared by
 * the phone-call control prompt (voice-session-bridge.ts) and the in-app
 * live-voice control prompt (live-voice/live-voice-session.ts) so the two
 * surfaces cannot drift on what a spoken reply is allowed to look like.
 *
 * Both rules describe the delivery path, not the surface: the caller hears
 * the text, and sanitizeForTts (tts-text-sanitizer.ts) strips markdown
 * syntax but keeps the content, so a five-bullet answer is still five
 * bullets of audio with the dashes removed. The length rule is what keeps
 * that answer from being produced in the first place.
 */

/** One to three spoken sentences; the caller is listening, not reading. */
export const SPOKEN_REPLY_LENGTH_RULE =
  "Keep each reply to one to three spoken sentences. The caller is listening, not reading: lead with the answer, say it in the fewest words that are still complete, and stop. No preamble, no recap of the question, no closing offer of more.";

/** Plain conversational text only; the text goes straight to a TTS engine. */
export const SPOKEN_REPLY_PLAIN_TEXT_RULE =
  "Your text is sent directly to a text-to-speech engine. Never use markdown formatting (asterisks, headers, backticks, links), bulleted or numbered lists, or emojis. Write plain conversational text only; if something is naturally a list, say it as one sentence.";
