// Short, persona-neutral phrases spoken to hold the floor when the model is
// slow to produce its first delta (voice-front-model). Pure floor-holders:
// they must never carry content or require domain knowledge, and they stay
// short (≤ 6 words) so they finish before the real reply's audio arrives.
export const ACK_PHRASES: readonly string[] = [
  "One sec — let me think.",
  "Let me look into that.",
  "Give me a moment.",
  "Hmm, let me check.",
  "Just a moment.",
];

// Deterministic rotation through ACK_PHRASES: callers hold a nonnegative
// monotonic counter, so consecutive acks vary while tests stay reproducible.
export function pickAckPhrase(counter: number): string {
  return ACK_PHRASES[counter % ACK_PHRASES.length];
}
