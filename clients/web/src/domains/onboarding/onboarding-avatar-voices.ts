/**
 * Which managed voice belongs to which onboarding avatar.
 *
 * The face step's audition existed once before and was pulled (#39073) because
 * every avatar auditioned the same default voice: hearing one generic voice out
 * of twelve different characters taught the opposite of what it was for. So the
 * pairing is the feature — the button says what *this* character sounds like,
 * and the answer changes as you cycle the carousel.
 *
 * Index-aligned with `HARDCODED_POOL` in `onboarding-avatar-pool-store`: the
 * cast is hand-picked and fixed, so the voices can be hand-picked too. Voices
 * are matched to each character's body/eyes/color (grumpy purple blob → dry and
 * formal; goofy teal urchin → bright and energetic), and spread across accents
 * and registers so cycling actually sounds like meeting different characters.
 *
 * Index 0 — the avatar the picker centers first — deliberately takes the
 * platform default voice, so a user who never touches the carousel gets exactly
 * the voice onboarding assistants got before per-avatar voices existed.
 *
 * Model ids come from the platform catalog (`speech_proxy/voice_catalog.py`),
 * which is the source of truth for what's offered and rate-carded. This list is
 * a *preference*, not a contract: `resolveAvatarVoice` falls back when the
 * platform stops offering one, so delisting a voice degrades the pairing
 * instead of breaking the step.
 */

import { type ManagedVoiceOption } from "@/lib/tts/use-managed-voices";

/** Preferred managed voice per avatar, indexed by position in the cast. */
export const AVATAR_VOICE_MODELS: readonly string[] = [
  "EXAVITQu4vr4xnSDxMaL", // 0 teal goofy urchin — Sarah, the platform default
  "onwK4e9ZLuTAKqWW03F9", // 1 purple grumpy blob — Daniel, formal and flat
  "TX3LPaxmHKxFdv7VOQHJ", // 2 orange surprised star — Liam, young and eager
  "aura-2-helena-en", //     3 pink gentle blob — Helena, caring
  "pNInz6obpgDQGcFmaJgB", // 4 yellow angry ninja — Adam, deep and firm
  "aura-2-luna-en", //       5 pink curious urchin — Luna, friendly
  "IKne3meq5aSn9XLyUdCD", // 6 orange quirky burst — Charlie, loose and lively
  "aura-2-pandora-en", //    7 green bashful ghost — Pandora, soft and calm
  "aura-2-apollo-en", //     8 orange dazed sprout — Apollo, unhurried
  "aura-2-thalia-en", //     9 teal goofy star — Thalia, bright
  "Xb7hH8MSUJpSbSDYk0k2", // 10 pink angry flower — Alice, crisp and pointed
  "aura-2-theia-en", //      11 yellow curious cloud — Theia, expressive
];

/**
 * The voice for the avatar at `index`, resolved against the catalog the
 * platform actually serves.
 *
 * Prefers this avatar's pairing. When the platform no longer offers it (a
 * delisting, or a rate card the pairing predates) any catalog voice beats no
 * audition at all, so fall back to a stable position in the catalog — stable so
 * two visits to the same avatar audition the same voice, and offset by `index`
 * so neighbouring avatars still differ. Null only when the catalog is empty
 * (not yet fetched, or the fetch failed).
 */
export function resolveAvatarVoice(
  index: number,
  voices: readonly ManagedVoiceOption[],
): ManagedVoiceOption | null {
  if (voices.length === 0) {
    return null;
  }
  const preferred = AVATAR_VOICE_MODELS[index % AVATAR_VOICE_MODELS.length];
  return (
    voices.find((voice) => voice.model === preferred) ??
    voices[index % voices.length] ??
    null
  );
}
