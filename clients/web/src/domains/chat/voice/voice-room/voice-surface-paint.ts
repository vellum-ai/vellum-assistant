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
 * Ink for a control that is currently *off* (mic muted, assistant muted).
 *
 * Not the negative theme token: that is a mid-tone red, and the surface is
 * painted an arbitrary avatar color, so the two can land close enough that the
 * muted glyph disappears into the fill. This is the room's own choice instead,
 * a pale red on dark fills and a deep one on light, which keeps "off" legible
 * on every palette color. Falls back to the token only for an unpainted
 * surface, where the theme is the right reference.
 *
 * Returned as a value for an inline style rather than a class: it competes with
 * the resting `--vbtn-fg` in {@link VOICE_SURFACE_CONTROL_CLASS}, and two
 * arbitrary-property utilities setting the same variable are ordered by
 * Tailwind's own sort, not by the order they are passed in.
 */
export function voiceSurfaceMutedInk(paint: VoiceSurfacePaint | null): string {
  if (!paint) {
    return "var(--system-negative-strong)";
  }
  return paint.tone.isLight ? "#991B1B" : "#FCA5A5";
}

/**
 * Control chrome toned for the fill under it. The token fallbacks only apply
 * if a caller renders a control without the vars, which no painted surface
 * does.
 *
 * The `touch-mobile:` half is not a duplicate of the resting half. An icon-only
 * ghost Button that expands on mobile takes an opaque chip there
 * (`touch-mobile:bg-[var(--surface-lift)]` plus a `--content-default`
 * foreground, see the design library's compound variants), which is right on
 * app chrome and wrong here: on a surface painted an arbitrary avatar color it
 * lands as a theme-colored tile floating on the fill. These re-state the
 * resting tones under the same variant so they win, and tailwind-merge drops
 * the library's conflicting classes rather than stacking them. The `40px` tap
 * target comes from a separate `touch-mobile:h-10 touch-mobile:w-10` pair, so
 * it survives untouched.
 *
 * Press feedback moves to `active:`, because `hover:` sits inside
 * `@media (hover: hover)` and a touch device never matches it, leaving a touch
 * control with no acknowledgement at all.
 */
export const VOICE_SURFACE_CONTROL_CLASS = [
  "[--vbtn-fg:var(--room-fg-muted,var(--content-secondary))]",
  "hover:[--vbtn-fg:var(--room-fg,var(--content-default))]",
  "hover:bg-[var(--room-wash,var(--surface-hover))]",
  "touch-mobile:bg-transparent",
  "touch-mobile:[--vbtn-fg:var(--room-fg-muted,var(--content-secondary))]",
  "touch-mobile:active:bg-[var(--room-wash,var(--surface-hover))]",
].join(" ");
