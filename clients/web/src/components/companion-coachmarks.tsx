/**
 * What the assistant is pointing at on the surface a call is being shown.
 *
 * Mounted inside the frame's window (`companion-watch-frame-page.tsx`), which
 * the macOS shell sizes to exactly what is being shared. That is what lets
 * this stay simple: a mark is a rectangle in fractions of the window, so a
 * percentage is the whole of the arithmetic and nothing here measures
 * anything.
 *
 * The ring is drawn outside the bounds it is given, never over them. The
 * point of the mark is that the user goes and uses the thing inside it, and a
 * ring that dimmed or covered the control would be pointing at something it
 * had just taken away.
 *
 * **Click-through, always.** The user's own drawing is the one layer on this
 * window that takes the mouse, and it takes it because a press is a mark
 * rather than a click. A coachmark is the opposite errand: it says press
 * *that*, so the press has to land on the app underneath.
 */

import { Fragment } from "react";

import { seedFor } from "@/components/companion-coachmark-path";
import {
  arrowPath,
  enclosurePath,
  HAND_ARROW,
  HAND_ENCLOSURE,
} from "@/components/companion-coachmark-shapes";
import { useWindowBox } from "@/components/companion-window-box";
import type {
  CompanionCoachmark,
  CompanionCoachmarkPoint,
  CompanionCoachmarkRegion,
} from "@vellumai/ipc-contract";

/**
 * Which side of its mark a caption hangs from, across the surface.
 *
 * A fraction, because the horizontal constraint is one: past `FLIP_X` of the
 * way across, the caption hangs from the mark's right edge and runs back
 * left. It pairs with the width a caption may take
 * ({@link CAPTION_MAX_WIDTH}), which is a fraction of the same surface: one
 * starting at `FLIP_X` and running the full width it is allowed ends exactly
 * at the far edge, so the flip cannot leave a caption hanging off the side.
 */
const CAPTION_FLIP_X = 0.6;
export const CAPTION_MAX_WIDTH = 0.4;

/**
 * The tallest a caption is drawn, in the window's pixels, plus the gap it
 * keeps from its mark.
 *
 * Pixels rather than a fraction, and that is the whole reason this constant
 * exists. The height a caption needs is set by the text in it, not by the
 * surface it is drawn on: a fraction that leaves room on a display leaves
 * none at the foot of a short window. The cap is real, held by the
 * `max-height` on `.companion-coachmark-caption`, so the two must move
 * together.
 */
export const CAPTION_BUDGET_PX = 58;
const CAPTION_GAP_PX = 10;

/**
 * How far an arrow reaches back from the point it indicates, in the window's
 * pixels.
 *
 * Pixels for the same reason the caption budget is: what it has to clear is
 * the caption, which is sized by its text. Long enough to read as an arrow
 * rather than a tick, short enough that its tail stays near the thing it
 * came from, so the eye travels the shortest distance from the words to the
 * control.
 */
const POINTER_LENGTH_PX = 52;

/**
 * How far short of the point the tip stops.
 *
 * The ring is drawn outside the bounds it is given so the control stays as
 * visible as it was; an arrow keeps the same promise by not landing on the
 * thing. It also reads better: a person pointing at something on a screen
 * does not touch it either.
 */
const POINTER_GAP_PX = 10;

/** Everything an arrow occupies on the side its tail hangs from. */
const POINTER_REACH_PX = POINTER_LENGTH_PX + POINTER_GAP_PX;

/**
 * How far outside its bounds the loop is drawn, in the window's pixels.
 *
 * The promise the mark makes: the control the user is being sent to is
 * exactly as visible as it was before anything was drawn on it. A loop traced
 * on the bounds would be a ring through the thing rather than around it.
 */
const RING_PADDING_PX = 10;

/**
 * Room for the stroke itself outside that, in the same pixels.
 *
 * The halo is drawn at nine pixels and centred on the path, so half of it
 * hangs outside the widest point the loop reaches. Without this the SVG's own
 * box would clip its edge, which reads as a ring with a flat side.
 *
 * The same nine pixels are why the standoff above is what it is: half of them
 * hang inside the line too, and the line is at its nearest to the bounds at a
 * corner, where `CORNER_CLEARANCE` of the standoff survives. Ten pixels of
 * standoff keeps about eight of them there, which the halo clears.
 */
const RING_MARGIN_PX = 8;

/** Which side of a mark its caption hangs from. */
export interface CaptionPlacement {
  above: boolean;
  trailing: boolean;
}

/**
 * The side a mark's caption hangs from, chosen so it stays on the surface.
 *
 * Below unless the room under the mark is short of what a caption can need,
 * measured against the window rather than assumed from a fraction of it. When
 * neither side has the room, the caption goes where there is more of it and
 * is held against that edge by {@link captionOffset}.
 *
 * Read off the mark's far edge rather than its origin: what has to stay on
 * screen is the caption, and the caption starts where the mark ends.
 */
export function captionPlacement(
  mark: CompanionCoachmark,
  windowHeight: number,
): CaptionPlacement {
  // An arrow occupies the side its caption hangs from, so what has to fit
  // below a point is the arrow and then the caption. A region occupies only
  // itself.
  const reach = mark.kind === "point" ? POINTER_REACH_PX : 0;
  const far = mark.kind === "point" ? mark.y : mark.y + mark.height;
  const width = mark.kind === "point" ? 0 : mark.width;
  const below = (1 - far) * windowHeight - reach;
  const above = mark.y * windowHeight - reach;
  return {
    above: below < CAPTION_BUDGET_PX && above > below,
    trailing: mark.x + width > CAPTION_FLIP_X,
  };
}

/**
 * How far a caption sits from the edge it is anchored to, in the window's
 * pixels.
 *
 * Held back from the far edge by the budget, so a mark against the foot of a
 * short window puts its caption above that edge rather than through it. The
 * caption is then nearer its mark than the gap asks for, which is the right
 * trade: a caption touching its mark still reads as belonging to it, and one
 * off the surface reads as nothing at all.
 */
export function captionOffset(
  mark: CompanionCoachmark,
  windowHeight: number,
  above: boolean,
): number {
  const edge = above
    ? 1 - mark.y
    : mark.kind === "point"
      ? mark.y
      : mark.y + mark.height;
  const room = Math.max(windowHeight - CAPTION_BUDGET_PX, 0);
  // Past the arrow, when there is one: the caption sits at its tail, so the
  // words and the arrow read as one gesture rather than two marks.
  const reach = mark.kind === "point" ? POINTER_LENGTH_PX : 0;
  // Whole pixels, for the reason {@link percent} rounds: the offset is a
  // fraction of a measured height, and the tail of that has nowhere to land
  // on a screen.
  return Math.round(
    Math.min(edge * windowHeight + reach + CAPTION_GAP_PX, room),
  );
}

/**
 * A fraction of the surface, held inside it, as a CSS percentage.
 *
 * Rounded, because a fraction reaches this as the difference of two others
 * and binary arithmetic leaves a tail well past what a display can draw. Four
 * places is a ten-thousandth of a screen, which is under a pixel on anything.
 */
function percent(fraction: number): string {
  const held = Math.min(Math.max(fraction, 0), 1) * 100;
  return `${Number(held.toFixed(4))}%`;
}

/**
 * A mark as its own identity, so one replacing another at the same position
 * in the set is a new element and plays its own entrance.
 *
 * What the assistant points at changes step by step through a task, and each
 * step is a new place to look. Reusing the element would move a ring the user
 * had already found rather than putting one where they have not looked yet.
 */
function markKey(mark: CompanionCoachmark): string {
  const extent =
    mark.kind === "region" ? `${mark.width},${mark.height}` : "point";
  return `${mark.kind},${mark.x},${mark.y},${extent},${mark.caption ?? ""}`;
}

/**
 * The loop, drawn around what it encloses in the companion's own hand.
 *
 * Built in the window's pixels rather than as fractions of it, for the reason
 * the arrow is: a curve shaped by percentages of a surface is a different
 * curve on every surface, and what a mark has to stay is recognisable. Only
 * where it sits is placed by fraction, which is the part that has to be
 * exact.
 *
 * The hand is seeded off the anchor, so the same control is looped the same
 * way every time it is pointed at. Pointing at one thing twice in a
 * conversation must not shimmer.
 */
function Enclosure({
  mark,
  box,
}: {
  mark: CompanionCoachmarkRegion;
  box: { width: number; height: number };
}) {
  // A mark can be thinner than a pixel on a small window, and a loop around
  // nothing is still a loop worth drawing: what it says is "here".
  const width = Math.max(mark.width * box.width, 1);
  const height = Math.max(mark.height * box.height, 1);
  const room = RING_PADDING_PX + RING_MARGIN_PX;
  const d = enclosurePath(
    { width, height },
    {
      strength: HAND_ENCLOSURE,
      seed: seedFor(mark.x, mark.y),
      padding: RING_PADDING_PX,
    },
  );
  return (
    <svg
      className="companion-coachmark"
      data-testid="companion-coachmark"
      aria-hidden="true"
      viewBox={`${-room} ${-room} ${width + room * 2} ${height + room * 2}`}
      width={width + room * 2}
      height={height + room * 2}
      style={{
        left: Math.round(mark.x * box.width - room),
        top: Math.round(mark.y * box.height - room),
      }}
    >
      <path className="companion-coachmark-halo" d={d} />
      <path className="companion-coachmark-ink" d={d} />
    </svg>
  );
}

/**
 * The arrow, with its tip on the point and its tail on the caption's side.
 *
 * Drawn in the window's own pixels rather than as fractions of it: a head
 * shaped by percentages of a surface is a different shape on every surface,
 * and the one thing an arrow has to stay is recognisable. Only the tip is
 * placed by fraction, which is the part that has to be exact.
 *
 * The shaft is drawn once and turned, so the two directions cannot drift
 * apart, and its hand is seeded off the point for the reason the loop's is.
 * The head is turned to sit on the end of the curve, so the arrow points
 * where the stroke was actually going rather than straight up a shaft that
 * leans.
 */
function Pointer({
  mark,
  above,
  box,
}: {
  mark: CompanionCoachmarkPoint;
  above: boolean;
  box: { width: number; height: number };
}) {
  const arrow = arrowPath({
    length: POINTER_LENGTH_PX,
    approach: above ? "above" : "below",
    strength: HAND_ARROW,
    seed: seedFor(mark.x, mark.y),
    gap: POINTER_GAP_PX,
  });
  return (
    <svg
      className="companion-coachmark-pointer"
      data-testid="companion-coachmark-pointer"
      data-above={above ? "" : undefined}
      aria-hidden="true"
      viewBox={`0 0 ${arrow.width} ${arrow.height}`}
      width={arrow.width}
      height={arrow.height}
      style={{
        // Half a head to the left of the tip, so the shaft runs through it.
        left: Math.round(mark.x * box.width - arrow.width / 2),
        // The gap the tip stops short by is inside the path, so the box is
        // hung straight off the point: below it when the tail hangs below,
        // and a whole box above it when the tail hangs above, which is what
        // puts the turned tip back on the point.
        top: Math.round(mark.y * box.height - (above ? arrow.height : 0)),
        // Through the variable the entrance composes with, never as a plain
        // transform: the keyframe's implicit end state is this element's own
        // transform, so an arrow that set one here would animate into its
        // rotation rather than arriving already turned.
        ...(above
          ? { ["--companion-coachmark-turn" as string]: "rotate(180deg)" }
          : {}),
      }}
    >
      <path className="companion-coachmark-halo" d={arrow.shaft} />
      <path className="companion-coachmark-halo" d={arrow.head} />
      <path className="companion-coachmark-ink" d={arrow.shaft} />
      <path className="companion-coachmark-ink" d={arrow.head} />
    </svg>
  );
}

export function CompanionCoachmarks({
  marks,
  ink,
}: {
  marks: readonly CompanionCoachmark[];
  ink: string;
}) {
  const box = useWindowBox();
  return (
    <div
      className="pointer-events-none fixed inset-0"
      data-testid="companion-coachmarks"
      style={{ ["--companion-ring-accent" as string]: ink }}
      role="presentation"
    >
      {marks.map((mark) => {
        const { above, trailing } = captionPlacement(mark, box.height);
        const offset = `${captionOffset(mark, box.height, above)}px`;
        return (
          // A fragment rather than a box around the pair: both are placed
          // against this layer, and a wrapper that positioned neither would
          // still be a node between them and the surface they measure from.
          <Fragment key={markKey(mark)}>
            {mark.kind === "region" ? (
              <Enclosure mark={mark} box={box} />
            ) : (
              <Pointer mark={mark} above={above} box={box} />
            )}
            {mark.caption !== undefined && mark.caption !== "" && (
              <div
                className="companion-coachmark-caption"
                data-testid="companion-coachmark-caption"
                data-above={above ? "" : undefined}
                data-trailing={trailing ? "" : undefined}
                style={{
                  // Anchored to the mark's far side when it hangs back the
                  // other way. A point's far side is the point.
                  ...(trailing
                    ? {
                        right: percent(
                          1 -
                            (mark.kind === "region"
                              ? mark.x + mark.width
                              : mark.x),
                        ),
                      }
                    : { left: percent(mark.x) }),
                  ...(above ? { bottom: offset } : { top: offset }),
                  maxWidth: percent(CAPTION_MAX_WIDTH),
                }}
              >
                {mark.caption}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
