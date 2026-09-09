/**
 * Drawing on the surface a call is being shown: the marks, and the presses
 * that make them.
 *
 * Mounted inside the frame's window (`companion-watch-frame-page.tsx`), which
 * the macOS shell sizes to exactly what is being shared. That is what lets
 * this stay simple: a press at the middle of this window is a press at the
 * middle of the shared surface, so a mark is described in fractions of the
 * window and needs no idea of where on the desktop any of it sits.
 *
 * **The marks are never in the pixels.** A capture excludes Vellum's own
 * windows (`ScreenCapture.swift`), so nothing drawn here reaches the call by
 * being on screen. What reaches it is the stroke data, sent on the release
 * and drawn onto the captured frame by the window that takes it
 * (`annotate-shared-frame.ts`). This page is what the user sees; that is the
 * copy the call sees, and both are made from the same numbers.
 *
 * **Nothing is sent while the hand is down.** A frame taken mid-stroke is a
 * circle half drawn, around nothing in particular; the moment a mark means
 * something is the moment it is finished. The `drawing` phase is what says so
 * to the window holding the session, and it is as much of the point as the
 * strokes are.
 *
 * The marks fade once they have been sent. They are a gesture rather than an
 * annotation layer: the user pointed at something and the call has the
 * picture, and a circle still sitting on the screen a minute later is a
 * circle they have to clear up.
 *
 * **The app underneath stays scrollable.** This layer takes the wheel along
 * with the presses, and a window cannot hand on a wheel event it has taken,
 * so on the first one it asks main to make the frame click-through for the
 * rest of the scroll (`setCompanionFrameScrolling`). Main takes the mouse
 * back when the scroll ends, which it hears from the desktop, and this layer
 * asks for it back on the first pointer move main forwards afterwards, in
 * case that comes first. Drawing is a mode the user is in, not a lock on the
 * surface they are sharing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWindowBox } from "@/components/companion-window-box";
import {
  annotateCompanionShare,
  setCompanionFrameScrolling,
} from "@/runtime/companion-surface";
import {
  COMPANION_ANNOTATION_MAX_POINTS,
  COMPANION_ANNOTATION_MAX_STROKES,
  COMPANION_ANNOTATION_MIN_STEP,
  COMPANION_ANNOTATION_STROKE,
} from "@vellumai/ipc-contract";

/**
 * How long a finished mark stays at full strength before it starts to go, and
 * how long it takes to go.
 *
 * The hold is the time it takes to say what the mark is about. The frame
 * leaves on the release, but the user is usually mid-sentence when the hand
 * comes off ("this button, here"), and a circle that has dissolved before the
 * sentence ends reads as a drawing that failed rather than one that was
 * sent. Long enough for that sentence and for the assistant to start
 * answering to it; short enough that the surface is clear again before the
 * next thing worth pointing at. The fade is slow enough to be a departure
 * rather than a blink.
 *
 * The overlay's stylesheet reads both through custom properties set on the
 * layer, so the moment the element is dropped and the moment its fade ends
 * are the same number.
 */
export const COMPANION_INK_HOLD_MS = 4500;
export const COMPANION_INK_FADE_MS = 900;

/** A fraction of the shared surface, held inside it. */
const clamp = (value: number): number => Math.min(Math.max(value, 0), 1);

/** One mark on the overlay, and whether it has been sent. */
interface LiveStroke {
  id: number;
  points: readonly { x: number; y: number }[];
  spent: boolean;
}

/**
 * Whether the pointer has travelled far enough from `last` to be worth
 * another point.
 *
 * The threshold is a fraction of the smaller side, so it means the same
 * distance on both axes; `aspect` converts the horizontal fraction into the
 * vertical's units before the two are compared. Squared, to keep a square
 * root out of a function that runs on every mouse-move.
 */
export function movedEnough(
  last: { x: number; y: number },
  next: { x: number; y: number },
  aspect: number,
): boolean {
  const dx = (next.x - last.x) * aspect;
  const dy = next.y - last.y;
  return dx * dx + dy * dy >= COMPANION_ANNOTATION_MIN_STEP ** 2;
}

/** Lucide's `pencil`, as path data: a cursor is an image, not an element. */
const PENCIL_MARKS =
  '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>' +
  '<path d="m15 5 4 4"/>';

/**
 * The pointer while drawing is on: a pencil, in the ink the mark will be.
 *
 * This is how the user learns the mode took: the pill's control is behind
 * them and the surface under the pointer is someone else's app, so the
 * pointer is the only thing on screen that can say a press here is now a
 * mark. Its colour is the mark's, for the same reason the frame's edge is.
 *
 * The ink is laid over a white halo so the pencil holds over a dark editor
 * and a white page alike. The hotspot is the pencil's tip, so a mark starts
 * where the pencil points. A crosshair stands behind it for a browser that
 * refuses the image.
 */
export function pencilCursor(ink: string): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="#ffffff" stroke-width="4">${PENCIL_MARKS}</g>` +
    `<g stroke="${ink}" stroke-width="2">${PENCIL_MARKS}</g>` +
    "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 22, crosshair`;
}

export function CompanionShareAnnotation({ ink }: { ink: string }) {
  const [strokes, setStrokes] = useState<readonly LiveStroke[]>([]);
  /**
   * The marks, as the handlers see them.
   *
   * The handlers read and write this and then mirror it into state, rather
   * than working through state updaters, because two of them have to do
   * something besides re-render: a move decides whether the next point is far
   * enough away to keep, and a release sends what is on the overlay. Neither
   * belongs inside an updater, which React is free to run more than once.
   */
  const live = useRef<readonly LiveStroke[]>([]);
  const drawing = useRef<number | null>(null);
  /**
   * Whether this layer last asked main to step aside for a scroll.
   *
   * Kept for the way back only, so a pointer resting after a scroll, which
   * is many moves, asks for the mouse once. It is not the truth about the
   * frame: main takes the mouse back on its own when the desktop says the
   * scroll has ended, and this layer is not told. So a wheel event never
   * reads it. One reaching this layer at all means the frame is holding the
   * mouse right now, whatever was asked for last.
   */
  const scrolling = useRef(false);
  const nextId = useRef(0);
  // The timers dropping spent marks once they have finished fading, cleared on
  // unmount so nothing is left to write to a component that has gone.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const box = useWindowBox();
  const aspect = box.height === 0 ? 1 : box.width / box.height;
  // The colour as the unmount sees it, kept in step after each render rather
  // than during one: the release below runs outside any render, and the
  // accent can change under a call while a mark is being made.
  const inkRef = useRef(ink);
  useEffect(() => {
    inkRef.current = ink;
  }, [ink]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) {
        clearTimeout(timer);
      }
      pending.clear();
      // **Never leave a hand down behind us.** `drawing` is what stops the
      // session sending frames, and only a `released` lifts it. This layer
      // goes away when the user turns the mode off or the share ends, either
      // of which can land mid-stroke, and a stroke with no release would hold
      // the next share's frames for a hand that came off long ago.
      if (drawing.current !== null) {
        drawing.current = null;
        annotateCompanionShare("released", [], inkRef.current);
      }
    };
  }, []);

  const commit = useCallback((next: readonly LiveStroke[]): void => {
    live.current = next;
    setStrokes(next);
  }, []);

  /**
   * Where a press landed, as a fraction of the surface being shared.
   *
   * Against the window rather than the element under the pointer, because the
   * window is what the shell sized to the shared surface: that equality is
   * the contract these fractions are measured against, and this layer merely
   * fills it. Client coordinates are already window-relative, so there is
   * nothing to subtract, and nothing here reads a layout box on a
   * mouse-move.
   *
   * **Clamped, and that is not a formality.** The pointer capture taken on
   * the press deliberately keeps a drag alive after the hand leaves the
   * shared surface, so a mark that runs off the edge arrives here as a
   * fraction below zero or above one. The wire refuses those (a fraction
   * outside the surface describes nowhere), and it refuses the whole
   * command, which would drop the `released` after a `drawing` had already
   * gone: the marks would be lost and the session would go on holding its
   * frames for a hand that is no longer down. The edge of the surface is the
   * truthful place for a mark drawn past it.
   */
  const pointOf = (
    event: React.PointerEvent<SVGSVGElement>,
  ): { x: number; y: number } => ({
    x: box.width === 0 ? 0 : clamp(event.clientX / box.width),
    y: box.height === 0 ? 0 : clamp(event.clientY / box.height),
  });

  /**
   * A wheel event on the layer is a scroll meant for the app under it, and
   * this window cannot hand it on: a window taking presses takes the wheel
   * with them. What it can do is ask main to stop taking them, so the rest of
   * the scroll reaches the app underneath. The one event that got here is
   * the price of finding out.
   *
   * Every one, not the first: while the frame is stepped aside the wheel
   * goes to the app and none arrive here, so one that does arrive is the
   * start of a scroll the frame is taking, either the first or the next
   * after main took the mouse back on its own. Main ignores an ask that
   * changes nothing.
   *
   * Not mid-stroke. The hand is down and captured, and a frame that let go
   * of the mouse now would lose the release that sends the mark and lifts
   * the hold on the session's frames.
   */
  const handleWheel = (): void => {
    if (drawing.current !== null) {
      return;
    }
    scrolling.current = true;
    setCompanionFrameScrolling(true);
  };

  /**
   * Take the mouse back after a scroll. Main forwards mouse-move while the
   * frame is stepped aside, so the first move to arrive is a hand that has
   * stopped scrolling and is pointing at something again. Main also takes it
   * back on its own when the desktop says the scroll has ended, so a press
   * with no move before it still lands here; that path never reaches this
   * layer, and the flag here is cleared by the next move either way.
   */
  const reclaim = (): void => {
    if (!scrolling.current) {
      return;
    }
    scrolling.current = false;
    setCompanionFrameScrolling(false);
  };

  const handleDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    reclaim();
    if (drawing.current !== null) {
      return;
    }
    // The capture is what keeps a stroke together when the hand leaves the
    // shared surface mid-drag. The window itself never takes focus: main
    // opens it unfocusable, so drawing on an app does not pull that app out
    // from under the user.
    event.currentTarget.setPointerCapture(event.pointerId);
    const id = nextId.current++;
    drawing.current = id;
    commit([...live.current, { id, points: [pointOf(event)], spent: false }]);
    // The hand is down: whatever cadence the session was sending frames on, it
    // stops here. This is the half of the feature that is not about drawing,
    // and the half the user only notices when it is missing.
    annotateCompanionShare("drawing", [], ink);
  };

  const handleMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    reclaim();
    const id = drawing.current;
    if (id === null) {
      return;
    }
    const next = pointOf(event);
    const stroke = live.current.find((candidate) => candidate.id === id);
    if (stroke === undefined) {
      return;
    }
    const last = stroke.points[stroke.points.length - 1];
    if (last !== undefined && !movedEnough(last, next, aspect)) {
      return;
    }
    commit(
      live.current.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              // The oldest point goes rather than the newest being refused: a
              // hand that has been drawing this long is still drawing, and
              // what it is drawing now is the part worth keeping.
              points: [...candidate.points, next].slice(
                -COMPANION_ANNOTATION_MAX_POINTS,
              ),
            }
          : candidate,
      ),
    );
  };

  const handleUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (drawing.current === null) {
      return;
    }
    drawing.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const sent = live.current.map((stroke) => ({ ...stroke, spent: true }));
    commit(sent);
    // Everything still on the overlay, not only the mark just finished. The
    // frame that goes with it is a picture of the shared surface at this
    // moment, and a mark the user can still see is part of what they are
    // pointing at.
    annotateCompanionShare(
      "released",
      sent
        .slice(-COMPANION_ANNOTATION_MAX_STROKES)
        .map((stroke) => ({ points: stroke.points })),
      ink,
    );
    const spent = new Set(sent.map((stroke) => stroke.id));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      commit(live.current.filter((stroke) => !spent.has(stroke.id)));
    }, COMPANION_INK_HOLD_MS + COMPANION_INK_FADE_MS);
    timers.current.add(timer);
  };

  // In the window's own pixels, resolved against the side the fraction means,
  // so this line and the one drawn onto the captured frame carry the same
  // weight relative to the surface they are on.
  const width = COMPANION_ANNOTATION_STROKE * Math.min(box.width, box.height);
  // Built once per colour rather than on every move: the layer re-renders as
  // the hand travels, and the cursor does not change under it.
  const cursor = useMemo(() => pencilCursor(ink), [ink]);

  return (
    <svg
      className="companion-share-annotation fixed inset-0 h-full w-full"
      style={
        {
          cursor,
          "--companion-ink-hold": `${COMPANION_INK_HOLD_MS}ms`,
          "--companion-ink-fade": `${COMPANION_INK_FADE_MS}ms`,
        } as React.CSSProperties
      }
      data-testid="companion-share-annotation"
      role="presentation"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onWheel={handleWheel}
    >
      {strokes.map((stroke) => (
        <Ink
          key={stroke.id}
          stroke={stroke}
          box={box}
          width={width}
          ink={ink}
        />
      ))}
    </svg>
  );
}

/**
 * One mark, in the window's pixels.
 *
 * Drawn at the measured size rather than in a stretched `viewBox`, so the
 * line has one thickness in both directions: a circle drawn on a wide display
 * through a unit box would come out as if it had been made with an oval nib.
 */
function Ink({
  stroke,
  box,
  width,
  ink,
}: {
  stroke: LiveStroke;
  box: { width: number; height: number };
  width: number;
  ink: string;
}) {
  const className = stroke.spent
    ? "companion-share-ink companion-share-ink-spent"
    : "companion-share-ink";
  const first = stroke.points[0];
  // A press that never moved is a dot: a polyline of one point draws nothing
  // at all, round caps included.
  if (stroke.points.length === 1 && first !== undefined) {
    return (
      <circle
        className={className}
        cx={first.x * box.width}
        cy={first.y * box.height}
        r={width / 2}
        fill={ink}
      />
    );
  }
  return (
    <polyline
      className={className}
      points={stroke.points
        .map((point) => `${point.x * box.width},${point.y * box.height}`)
        .join(" ")}
      fill="none"
      stroke={ink}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
