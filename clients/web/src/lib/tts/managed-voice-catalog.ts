/**
 * Display helpers for managed (Vellum) TTS voices.
 *
 * The voice list itself is fetched from the platform (`useManagedVoices`) —
 * the platform's billing rate card is the single source of truth for which
 * voices are offered. This module only holds client-side presentation
 * helpers for whatever the platform serves.
 */

// Keyed loosely (by string) so labels also resolve for sources that arrive
// from the platform voices endpoint before this file learns about them;
// callers fall back to the raw source string on a miss.
export const MANAGED_VOICE_SOURCE_LABELS: Record<string, string> = {
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
};

/**
 * Split a voice `description` ("American · calm, smooth, professional") into its
 * character traits and its accent. The traits are the distinguishing part, so
 * UIs lead with them and de-emphasize the accent; `traits` is also the natural
 * sort key. Falls back to the whole string as `traits` (empty accent) if the
 * expected " · " separator is absent.
 */
export function splitVoiceDescription(description: string): {
  traits: string;
  accent: string;
} {
  const separator = " · ";
  const index = description.indexOf(separator);
  if (index === -1) return { traits: description, accent: "" };
  return {
    accent: description.slice(0, index),
    traits: description.slice(index + separator.length),
  };
}

/**
 * How a voice is named in a picker: its character traits in sentence case, with
 * no proper name (the assistant has its own) and no accent — pickers group by
 * accent, so repeating it per row is noise.
 */
export function voiceTraitsLabel(description: string): string {
  const { traits } = splitVoiceDescription(description);
  return traits.charAt(0).toUpperCase() + traits.slice(1);
}

/**
 * Group voices by accent for display: groups A–Z, voices within a group by
 * traits. Grouping is what lets each row drop its accent — a catalog that is
 * mostly one accent would otherwise repeat it on every line. Voices with no
 * parseable accent collect under "Other".
 */
export function groupVoicesByAccent<T extends { description: string }>(
  voices: readonly T[],
): Array<{ accent: string; voices: T[] }> {
  const byAccent = new Map<string, T[]>();
  for (const voice of voices) {
    const { accent } = splitVoiceDescription(voice.description);
    const key = accent || "Other";
    const list = byAccent.get(key);
    if (list) list.push(voice);
    else byAccent.set(key, [voice]);
  }
  return [...byAccent.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([accent, list]) => ({
      accent,
      voices: [...list].sort((a, b) =>
        splitVoiceDescription(a.description).traits.localeCompare(
          splitVoiceDescription(b.description).traits,
        ),
      ),
    }));
}
