import type { LiveVoiceSpokenAckKind } from "./live-voice-metrics.js";

// Short, persona-neutral phrases spoken to hold the floor when the model is
// slow to produce its first delta. Pure floor-holders:
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

// Static fallbacks for an idle-triggered progress narration whose LLM
// phrasing failed — the one case where prolonged silence is actively harmful.
// The idle trigger can fire on a slow turn with zero tool activity, so every
// phrase stays strictly neutral: no claims about running tools or tasks.
// Same rules as the ack lists: persona-neutral, no domain content, ≤ 8 words.
// Exported so tests can assert the neutrality invariant against the list.
export const PROGRESS_FALLBACK_PHRASES: readonly string[] = [
  "Still on it — one moment.",
  "Still thinking this through.",
  "Almost there — thanks for waiting.",
];

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

// Same rotation contract as pickAckPhrase, over the progress fallbacks.
export function pickProgressPhrase(counter: number): string {
  return PROGRESS_FALLBACK_PHRASES[counter % PROGRESS_FALLBACK_PHRASES.length];
}
