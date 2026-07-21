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
