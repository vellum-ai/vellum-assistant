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

import type { CompanionCoachmark } from "@vellumai/ipc-contract";

/**
 * Where a caption goes rather than off the edge of the surface.
 *
 * A caption hangs off one corner of its mark, so a mark near an edge is the
 * case that decides the corner. Past `FLIP_X` of the way across, the caption
 * hangs from the mark's right edge and runs left; past `FLIP_Y` down, it sits
 * above the mark instead of below. The thresholds pair with the width the
 * caption is allowed ({@link CAPTION_MAX_WIDTH}): a caption starting at
 * `FLIP_X` and running the full width it may take ends exactly at the far
 * edge, so neither flip can leave one hanging off the surface.
 */
const CAPTION_FLIP_X = 0.6;
const CAPTION_FLIP_Y = 0.85;
export const CAPTION_MAX_WIDTH = 0.4;

/** Which corner of a mark its caption hangs from. */
export interface CaptionPlacement {
  above: boolean;
  trailing: boolean;
}

/**
 * The corner a mark's caption hangs from, chosen so it stays on the surface.
 *
 * Read off the mark's own far edges rather than its origin: what has to stay
 * on screen is the caption, and the caption starts where the mark ends.
 */
export function captionPlacement(mark: CompanionCoachmark): CaptionPlacement {
  return {
    above: mark.y + mark.height > CAPTION_FLIP_Y,
    trailing: mark.x + mark.width > CAPTION_FLIP_X,
  };
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
  return (
    <div
      className="pointer-events-none fixed inset-0"
      data-testid="companion-coachmarks"
      style={{ ["--companion-ring-accent" as string]: ink }}
      role="presentation"
    >
      {marks.map((mark) => {
        const { above, trailing } = captionPlacement(mark);
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
                  ...(above
                    ? { bottom: percent(1 - mark.y) }
                    : { top: percent(mark.y + mark.height) }),
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
