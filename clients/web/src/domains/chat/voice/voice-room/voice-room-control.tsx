/**
 * Every circular icon control in the room: the corner minimize, the two mutes,
 * the camera toggle, flip camera, end session.
 *
 * The treatment varies along three axes, so it lives in one place rather than
 * being assembled per call site: neutral vs destructive toning, bordered vs
 * bare, and whether the viewfinder is open behind the control. A scrim that
 * every call site has to remember is one that reaches most of the row and
 * misses a control.
 *
 * The element is a bare `<button>`, not the design library's `Button`. These
 * are 48px circles; `Button`'s sizes stop at `h-8` with `rounded-md` on every
 * one of them, and it carries `active:scale-[0.97]` plus a theme-token focus
 * ring. The room paints itself an arbitrary avatar color, so theme tokens are
 * as likely to be invisible on it as legible, which is what the `--room-*`
 * contract exists to replace. The library also has no treatment for chrome
 * over live video.
 *
 * The sibling voice surfaces (the composer bar, the header pill) do use
 * `Button` with `VOICE_SURFACE_CONTROL_CLASS` from `voice-surface-paint.ts`,
 * where the library's shape suits their size. This reads the same `--room-*`
 * vars that module publishes, so all three surfaces are one visual system.
 */

import { Tooltip, cn } from "@vellumai/design-library";
import type { ReactNode } from "react";

/**
 * The treatment for a control sitting over the open viewfinder.
 *
 * Every other treatment here is derived from the assistant's avatar tone,
 * which is the correct reference right up until the camera opens: the feed
 * then covers the look edge to edge, so the tone describes a background nobody
 * can see, and a control whose entire resting appearance is a 15%-white
 * hairline simply is not there over a dark shirt.
 *
 * Fixed colors rather than tone-derived ones, deliberately. What sits behind
 * these is arbitrary camera video, not a color the room picked, so there is
 * nothing to derive from. The blur is what keeps the scrim honest over a busy
 * frame without having to push the fill toward opaque.
 */
const OVER_MEDIA_NEUTRAL_CLASS =
  "border-white/25 bg-black/45 text-white backdrop-blur-sm hover:bg-black/60 hover:text-white focus-visible:outline-white";

/**
 * The red worn by a control that is doing something to the call: the two mutes
 * while engaged, and end-session always.
 *
 * Three variants because the room's background is the assistant's avatar
 * color, which can be a light one (yellow). A single red picked against the
 * dark look washes out over that, so `isLight` swaps to the darker red the
 * tone helper's foreground colors are chosen against. Over the viewfinder
 * neither applies: the fill carries the same weight the neutral scrim does,
 * keeping the red identity while staying readable on whatever is in frame, and
 * the glyph goes white because a red-on-red icon is the first thing to
 * disappear.
 */
function destructiveClass(overMedia: boolean, isLight: boolean): string {
  if (overMedia) {
    return "border-red-200/40 bg-red-600/55 text-white backdrop-blur-sm hover:bg-red-600/70 focus-visible:outline-white";
  }
  return isLight
    ? "border-red-700/50 bg-red-600/15 text-red-800 hover:bg-red-600/25"
    : "border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30";
}

export interface VoiceRoomControlProps {
  /** Accessible name, and the tooltip's text unless `tooltip` overrides it. */
  label: string;
  /**
   * Tooltip text, when it needs to say more than the accessible name. The
   * minimize control is the case: its name has to be the act ("Minimize voice
   * room") while the tooltip answers the question the act raises ("session
   * keeps going").
   */
  tooltip?: string;
  onClick: () => void;
  /** The glyph. Sized by the caller, since the shutter's siblings vary. */
  children: ReactNode;
  /**
   * `destructive` for a control acting ON the call: a mute while engaged, and
   * end-session always. Defaults to the neutral toning.
   */
  tone?: "neutral" | "destructive";
  /** True while the viewfinder is open behind this control. */
  overMedia?: boolean;
  /** The room's look is a light avatar color, so reds need the darker pick. */
  isLight?: boolean;
  /**
   * Corner chrome (the minimize control) wears no border: it sits alone
   * against the look rather than in a row of peers that need to read as a set.
   */
  bare?: boolean;
  /** Mirrors a toggle's state to assistive tech. */
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function VoiceRoomControl({
  label,
  tooltip,
  onClick,
  children,
  tone = "neutral",
  overMedia = false,
  isLight = false,
  bare = false,
  pressed,
  disabled,
  className,
  "data-testid": testId,
}: VoiceRoomControlProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          "flex size-12 items-center justify-center rounded-full transition",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]",
          !bare && "border",
          tone === "destructive"
            ? destructiveClass(overMedia, isLight)
            : cn(
                bare
                  ? "text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]"
                  : "border-[var(--room-border)] text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]",
                overMedia && OVER_MEDIA_NEUTRAL_CLASS,
              ),
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
