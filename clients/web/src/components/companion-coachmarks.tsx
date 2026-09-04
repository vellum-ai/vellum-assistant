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

import { useWindowBox } from "@/components/companion-window-box";
import type { CompanionCoachmark } from "@vellumai/ipc-contract";

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
  const below = (1 - (mark.y + mark.height)) * windowHeight;
  const above = mark.y * windowHeight;
  return {
    above: below < CAPTION_BUDGET_PX && above > below,
    trailing: mark.x + mark.width > CAPTION_FLIP_X,
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
  const edge = above ? 1 - mark.y : mark.y + mark.height;
  const room = Math.max(windowHeight - CAPTION_BUDGET_PX, 0);
  // Whole pixels, for the reason {@link percent} rounds: the offset is a
  // fraction of a measured height, and the tail of that has nowhere to land
  // on a screen.
  return Math.round(Math.min(edge * windowHeight + CAPTION_GAP_PX, room));
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
  return `${mark.x},${mark.y},${mark.width},${mark.height},${mark.caption ?? ""}`;
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
            <div
              className="companion-coachmark"
              data-testid="companion-coachmark"
              style={{
                left: percent(mark.x),
                top: percent(mark.y),
                width: percent(mark.width),
                height: percent(mark.height),
              }}
            />
            {mark.caption !== undefined && mark.caption !== "" && (
              <div
                className="companion-coachmark-caption"
                data-testid="companion-coachmark-caption"
                data-above={above ? "" : undefined}
                data-trailing={trailing ? "" : undefined}
                style={{
                  ...(trailing
                    ? { right: percent(1 - (mark.x + mark.width)) }
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
