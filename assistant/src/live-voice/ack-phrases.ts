import type { LiveVoiceSpokenAckKind } from "./live-voice-metrics.js";

// Short, persona-neutral phrases spoken to hold the floor when the model is
// slow to produce its first delta (voice-front-model). Pure floor-holders:
// they must never carry content or require domain knowledge, and they stay
// short (≤ 6 words) so they finish before the real reply's audio arrives.
const ACK_PHRASES: readonly string[] = [
  "One sec — let me think.",
  "Let me look into that.",
  "Give me a moment.",
  "Hmm, let me check.",
  "Just a moment.",
];

// Tool-flavored variant spoken the moment a turn starts tool use (a
// guaranteed-slow turn). Same rules as ACK_PHRASES: persona-neutral, no
// domain content, ≤ 6 words.
const TOOL_ACK_PHRASES: readonly string[] = [
  "Let me check that.",
  "Looking that up now.",
  "Let me pull that up.",
  "One moment, checking.",
  "Give me a second here.",
];

const PHRASES_BY_KIND: Record<LiveVoiceSpokenAckKind, readonly string[]> = {
  first_delta: ACK_PHRASES,
  tool_use: TOOL_ACK_PHRASES,
};

// Deterministic rotation through the kind's phrase list: callers hold a
// nonnegative monotonic counter, so consecutive acks vary while tests stay
// reproducible.
export function pickAckPhrase(
  kind: LiveVoiceSpokenAckKind,
  counter: number,
): string {
  const phrases = PHRASES_BY_KIND[kind];
  return phrases[counter % phrases.length];
}
