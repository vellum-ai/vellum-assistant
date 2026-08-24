/**
 * Resolves what a live-voice surface paints itself with, from the session
 * assistant's avatar: the room's fill and the foreground tones that keep chrome
 * legible on it (see `voice-surface-paint.ts`). One hook, so the pill and the
 * room can never disagree about the session's color.
 */

import { toneForBg } from "@/utils/avatar-tone";

import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

import { VOICE_SURFACE_DARK, resolveVoiceRoomLook } from "./voice-room-eyes";
import { useCustomAvatarFieldHex } from "./use-custom-avatar-field";
import type { VoiceSurfacePaint } from "./voice-surface-paint";

/**
 * Null until the avatar query settles. `resolveVoiceRoomLook`
 * returns null both for "no character color" and for "not fetched yet", so
 * painting on the in-flight read would flash the surface to the ambient dark
 * and then again to the avatar color; holding null until the answer is real
 * lets the caller keep its normal surface and change color once.
 *
 * An uploaded-image avatar has its color sampled off the image, which lands a
 * beat after the query does, so that one does change color a second time: the
 * surface holds the ambient dark until the sample arrives. Painting the room a
 * color while the pill it minimizes into stayed dark would be the more visible
 * wrong, and a failed sample still lands on that same dark.
 *
 * Pass a null `assistantId` to skip the fetch entirely (a hidden surface).
 */
export function useVoiceSurfacePaint(
  assistantId: string | null,
): VoiceSurfacePaint | null {
  const { components, traits, customImageUrl, isLoading } =
    useAssistantAvatar(assistantId);
  const customFieldHex = useCustomAvatarFieldHex(customImageUrl);

  if (!assistantId || isLoading) {
    return null;
  }

  const look = resolveVoiceRoomLook(components, traits, customImageUrl);
  const bgHex = look?.bgHex ?? customFieldHex ?? VOICE_SURFACE_DARK;
  return { bgHex, tone: toneForBg(bgHex) };
}
