// Longest legitimate emoji are ZWJ sequences (family, couple, flags with
// tags) — all comfortably under 32 UTF-16 code units. Anything longer is a
// sentence, not a reaction.
const EMOJI_MAX_LENGTH = 32;

/**
 * True when `value` is a single emoji grapheme: exactly one grapheme
 * cluster containing at least one pictographic scalar. Covers plain emoji,
 * variation-selector forms, ZWJ sequences, skin tones, keycaps, and
 * regional-indicator flags while rejecting plain text and multi-emoji
 * strings.
 */
export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > EMOJI_MAX_LENGTH) {
    return false;
  }
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      value,
    ),
  ];
  if (segments.length !== 1) {
    return false;
  }
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u.test(
    value,
  );
}
