/**
 * Every circular icon control in the room: the corner minimize, the two mutes,
 * the camera toggle, flip camera, end session.
 *
 * The treatment varies along three axes, so it lives in one place rather than
 * being assembled per call site: the toning, bordered vs bare, and what is
 * behind the control. A scrim that every call site has to remember is one that
 * reaches most of the row and misses a control.
 *
 * The element is a bare `<button>`, not the design library's `Button`. These
 * are 52px circles; `Button`'s sizes stop at `h-8` with `rounded-md` on every
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

import { CAMERA_MEDIA_GLASS_CLASS, cameraModeStyle } from "./camera-mode-paint";

/**
 * The treatment for a control sitting over video: the deep-link capture
 * overlay's two, and the room's corner chrome once the viewfinder is up.
 *
 * Every other treatment here is derived from the assistant's avatar tone,
 * which is the correct reference right up until the camera opens: the feed
 * then covers the look edge to edge, so the tone describes a background nobody
 * can see, and a control whose entire resting appearance is a 15%-white
 * hairline simply is not there over a dark shirt.
 *
 * Fixed colors rather than tone-derived ones, deliberately. What sits behind
 * these is arbitrary camera video, not a color the room picked, so there is
 * nothing to derive from. The scrim itself is `camera-mode-paint.ts`'s, shared
 * with the camera's failure message; only the hairline and the hover belong to
 * a control.
 */
const OVER_MEDIA_NEUTRAL_CLASS = cn(
  CAMERA_MEDIA_GLASS_CLASS,
  "border-white/25 hover:bg-black/60 hover:text-white focus-visible:outline-white",
);

/**
 * Camera mode's palette for the room's own row: every control filled, and told
 * apart by what it does rather than by an outline.
 *
 * Glass is the wrong instrument once the whole surface is a viewfinder. The
 * row then sits on the busiest background the app ever paints, and five
 * translucent circles over it read as one smear; the design fills them
 * instead, and spends color on the only distinction that matters at arm's
 * length: what will happen if you hit the wrong one.
 *
 * Hover dips the whole control rather than moving to a fourth fill. Each of
 * these is the design's exact value, and a hover color invented beside it
 * would be a color no table names.
 */
const CAMERA_LIVE_CLASS =
  "border-transparent bg-white text-[var(--camera-ink)] hover:opacity-90 focus-visible:outline-white";
const CAMERA_NEUTRAL_CLASS =
  "border-transparent bg-[var(--camera-warm)] text-white hover:opacity-90 focus-visible:outline-white";
const CAMERA_ENGAGED_CLASS =
  "border-transparent bg-[var(--camera-warm-strong)] text-white hover:opacity-90 focus-visible:outline-white";
const CAMERA_DESTRUCTIVE_CLASS =
  "border-transparent bg-[var(--camera-destructive)] text-white hover:opacity-90 focus-visible:outline-white";

/** What is behind the control. See {@link VoiceRoomControlProps.surface}. */
export type VoiceRoomControlSurface = "room" | "media" | "camera";

/** How the control is toned. See {@link VoiceRoomControlProps.tone}. */
export type VoiceRoomControlTone = "neutral" | "destructive" | "live";

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
function destructiveClass(
  surface: VoiceRoomControlSurface,
  isLight: boolean,
): string {
  if (surface === "camera") {
    return CAMERA_DESTRUCTIVE_CLASS;
  }
  if (surface === "media") {
    return "border-red-200/40 bg-red-600/55 text-white backdrop-blur-sm hover:bg-red-600/70 focus-visible:outline-white";
  }
  return isLight
    ? "border-red-700/50 bg-red-600/15 text-red-800 hover:bg-red-600/25"
    : "border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30";
}

/** The whole treatment: three tones across three surfaces, resolved in one place. */
function treatmentClass({
  tone,
  surface,
  isLight,
  bare,
  pressed,
}: {
  tone: VoiceRoomControlTone;
  surface: VoiceRoomControlSurface;
  isLight: boolean;
  bare: boolean;
  pressed: boolean;
}): string {
  if (tone === "destructive") {
    return destructiveClass(surface, isLight);
  }
  // Corner chrome keeps the glass treatment even in camera mode. The warm
  // fills are how the bottom row reads as one set of related acts, and a
  // filled circle in the corner would join a set it is not in.
  if (surface === "camera" && !bare) {
    if (tone === "live") {
      return CAMERA_LIVE_CLASS;
    }
    // An engaged toggle sits a shade heavier than the resting controls beside
    // it: the camera control is held down for as long as the viewfinder is up,
    // and flip, which toggles nothing, takes the lighter warm.
    return pressed ? CAMERA_ENGAGED_CLASS : CAMERA_NEUTRAL_CLASS;
  }
  return cn(
    bare
      ? "text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]"
      : "border-[var(--room-border)] text-[var(--room-fg-muted)] hover:bg-[var(--room-wash)] hover:text-[var(--room-fg)]",
    surface !== "room" && OVER_MEDIA_NEUTRAL_CLASS,
  );
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
   * end-session always. `live` for the one that shows the session is running,
   * which in camera mode is filled solid white: a viewfinder covers the room's
   * face, so nothing else on screen answers "is she still listening", and an
   * un-slashed mic on glass leaves that answer to an absence of red. Off the
   * camera surface `live` IS the neutral toning, since the room's own look
   * answers it. Defaults to neutral.
   */
  tone?: VoiceRoomControlTone;
  /**
   * What is behind the control: the room's own look, arbitrary video (the
   * deep-link capture overlay), or the room in camera mode, which paints its
   * whole chrome from the `--camera-*` contract. One axis rather than a
   * boolean per surface, since a control is only ever on one of them.
   */
  surface?: VoiceRoomControlSurface;
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
  surface = "room",
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
        style={surface === "camera" ? cameraModeStyle() : undefined}
        className={cn(
          // 52px, in every state. The row is the same one whether or not the
          // viewfinder is up, and a control that resized as the camera opened
          // would move under a thumb already on its way to it.
          "flex size-13 items-center justify-center rounded-full transition",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--room-fg-muted)]",
          !bare && "border",
          treatmentClass({
            tone,
            surface,
            isLight,
            bare,
            pressed: Boolean(pressed),
          }),
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
