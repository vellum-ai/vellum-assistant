/**
 * Resolves what a live-voice surface paints itself with, from the session
 * assistant's avatar: the room's fill and its foreground tones (see
 * `voice-surface-paint.ts`), plus the accent the mesh band tints itself with.
 * One hook, so the pill and the room can never disagree about the session's
 * color.
 */

import { toneForBg } from "@/utils/avatar-tone";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

import { VOICE_SURFACE_DARK, resolveVoiceRoomLook } from "./voice-room-eyes";
import type { VoiceSurfacePaint } from "./voice-surface-paint";
import { resolveWaveAccentHex } from "./wave-accent";

/**
 * `paint` is null until the avatar query settles. `resolveVoiceRoomLook`
 * returns null both for "no character color" and for "not fetched yet", so
 * painting on the in-flight read would flash the surface to the ambient dark
 * and then again to the avatar color; holding null until the answer is real
 * lets the caller keep its normal surface and change color once.
 *
 * Pass a null `assistantId` to skip the fetch entirely (a hidden surface).
 */
export function useVoiceSurfacePaint(assistantId: string | null): {
  paint: VoiceSurfacePaint | null;
  waveAccentHex: string | null;
} {
  const { components, traits, customImageUrl, isLoading } =
    useAssistantAvatar(assistantId);

  const waveAccentHex = resolveWaveAccentHex(
    components,
    traits,
    customImageUrl,
  );

  if (!assistantId || isLoading) {
    return { paint: null, waveAccentHex };
  }

  const look = resolveVoiceRoomLook(components, traits, customImageUrl);
  const bgHex = look?.bgHex ?? VOICE_SURFACE_DARK;
  return { paint: { bgHex, tone: toneForBg(bgHex) }, waveAccentHex };
}
