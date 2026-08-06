// Static fallbacks for an idle-triggered progress narration whose LLM
// phrasing failed — the one case where prolonged silence is actively harmful.
// The idle trigger can fire on a slow turn with zero tool activity, so every
// phrase stays strictly neutral: no claims about running tools or tasks.
// Persona-neutral, no domain content, ≤ 8 words.
// Exported so tests can assert the neutrality invariant against the list.
export const PROGRESS_FALLBACK_PHRASES: readonly string[] = [
  "Still on it — one moment.",
  "Still thinking this through.",
  "Almost there — thanks for waiting.",
];

// Deterministic rotation through the phrase list: callers hold a nonnegative
// monotonic counter, so consecutive picks vary while tests stay reproducible.
export function pickProgressPhrase(counter: number): string {
  return PROGRESS_FALLBACK_PHRASES[counter % PROGRESS_FALLBACK_PHRASES.length];
}
