/**
 * The paint a live-voice surface wears away from the room: the room's own
 * background color, plus the foreground tones that keep chrome legible on top
 * of it.
 *
 * The room, the minimized composer block and the header pill are one surface at
 * three sizes, so they all fill with the same color: the session assistant's
 * avatar color, or the room's deep ambient surface for an assistant with no
 * character color to borrow. {@link useVoiceSurfacePaint} resolves it; this
 * module is the presentational half, so a surface can wear the paint without
 * pulling the avatar query into its import graph.
 *
 * Because the fill is an arbitrary avatar color, chrome drawn on it cannot use
 * theme tokens: `--content-default` is as likely to be invisible on it as
 * legible. The tones ship as the `--room-*` vars (the contract the room
 * already uses), and the surface's controls read those.
 */

import type { CSSProperties } from "react";

import type { AvatarTone } from "@/utils/avatar-tone";

export interface VoiceSurfacePaint {
  /** Fill color: the avatar's color, or the room's deep ambient surface. */
  bgHex: string;
  /** Foreground tones for chrome drawn on that fill. */
  tone: AvatarTone;
}

/**
 * The fill plus the `--room-*` vars for it, as an inline style. Pair it with
 * `data-theme` (see {@link voiceSurfaceTheme}) so descendants reading plain
 * theme tokens flip polarity with the fill rather than against it.
 */
export function voiceSurfaceStyle(paint: VoiceSurfacePaint): CSSProperties {
  return {
    backgroundColor: paint.bgHex,
    "--room-fg": paint.tone.fg,
    "--room-fg-muted": paint.tone.fgMuted,
    "--room-wash": paint.tone.wash,
  } as CSSProperties;
}

/** `data-theme` value matching the fill's polarity. */
export function voiceSurfaceTheme(
  paint: VoiceSurfacePaint | null,
): "light" | "dark" | undefined {
  if (!paint) {
    return undefined;
  }
  return paint.tone.isLight ? "light" : "dark";
}

/**
 * Control chrome toned for the fill under it. The token fallbacks only apply
 * if a caller renders a control without the vars, which no painted surface
 * does.
 */
export const VOICE_SURFACE_CONTROL_CLASS = [
  "[--vbtn-fg:var(--room-fg-muted,var(--content-secondary))]",
  "hover:[--vbtn-fg:var(--room-fg,var(--content-default))]",
  "hover:bg-[var(--room-wash,var(--surface-hover))]",
].join(" ");
