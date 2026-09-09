/**
 * The frame around what is being read: a border, and one line of words at
 * the top of it.
 *
 * Drawn in its own click-through window, which the macOS shell opens for a
 * watch session or a call's screen share, sizes to whatever is being read (a
 * display, or the one window or tab the user picked), moves with it, and
 * closes after it (`clients/macos/src/main/companion-window.ts`). The surface
 * being read says so on its own edge, the way a shared screen is framed, so a
 * capture is never something only a ring on a creature in one corner admits
 * to.
 *
 * Both kinds of read get the same border, because the fact the border states
 * is the same one: this surface is leaving the machine. Which control started
 * it is the pill's business, not the desktop's. The label is where the two
 * part: it says which way the surface is leaving and to whom, in words, and
 * stays up for as long as the border does. An edge alone is a thing the eye
 * can learn to stop seeing; a sentence at the top of the screen is not.
 *
 * A border and no glow, deliberately. A frame's job is to say exactly where
 * the read stops, and light bleeding inward from the edge says the opposite:
 * it dims the thing the user is working on and makes the boundary a
 * gradient. The edge is the whole signal, so it is drawn to hold on any
 * background: the accent between a white hairline and a dark rim, rather
 * than the accent alone, which vanishes against a wallpaper near its own
 * colour.
 *
 * Drawn in the assistant's own accent, the colour the call pill is ringed in,
 * and resolved through the same `companionAccentHexFor` the surface uses so
 * the two lights cannot come apart. The frame is one end of something the
 * pill is the other end of: a screen going to *this* assistant. A colour of
 * its own makes the border a second, unrelated light on the same desktop,
 * leaving the user to work out that the two are about one session.
 *
 * **It draws the session and holds none of it.** The window is pushed the
 * same state the companion surface is, and draws when that state says a
 * session is reading the screen. Where the window sits is the shell's; this
 * page only paints to its own edges.
 *
 * The page takes the mouse in exactly one case: while a call is being shown
 * this surface and the user has turned drawing on, when the marks they make
 * on it go to the call with the next frame
 * (`companion-share-annotation.tsx`). Main is what makes the window take
 * presses at all, so the two cannot disagree about where a click on the
 * shared surface goes. Everything else here is decoration on a desktop it
 * does not own.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  companionAccentHexFor,
  COMPANION_DEFAULT_ACCENT,
} from "@/components/companion-accent";
import { CompanionCoachmarks } from "@/components/companion-coachmarks";
import { CompanionShareAnnotation } from "@/components/companion-share-annotation";
import { useTranslation } from "@/i18n";
import {
  getCompanionState,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import type {
  CompanionSurfaceState,
  WatchCaptureTarget,
} from "@vellumai/ipc-contract";

/**
 * What the frame is around, as the one thing the label has to say.
 *
 * The watch session first, because the shell frames it first (`framedTarget`
 * in `companion-window.ts`): while both run, the window this is drawn in is
 * around the watched surface, and a label naming the share would be a
 * sentence about a surface this window is not on.
 */
type FramedRead =
  | { kind: "teaching" }
  | { kind: "sharing"; target: WatchCaptureTarget };

function framedRead(
  watching: boolean,
  screenShare: WatchCaptureTarget | undefined,
): FramedRead | null {
  if (watching) {
    return { kind: "teaching" };
  }
  if (screenShare !== undefined) {
    return { kind: "sharing", target: screenShare };
  }
  return null;
}

/**
 * The words at the top of the framed surface: what is happening to it, and
 * the name of the assistant it is happening to.
 *
 * A display and a window are told apart because the difference is the one
 * the user cares about: a shared window is one thing, a shared screen is
 * everything on it. A Chrome tab reaches here as the window it was raised
 * into, so it reads as a window, which is what is on screen.
 *
 * Named after the assistant when the app has said who that is, and plain
 * when it has not, the way the call pill's "Calling" is: a name the shell
 * has not published yet is not one to leave a hole for.
 */
function CompanionWatchFrameLabel({
  read,
  assistantName,
  style,
}: {
  read: FramedRead;
  assistantName: string;
  style: CSSProperties | undefined;
}) {
  const { t } = useTranslation();
  const named = assistantName !== "";
  const words =
    read.kind === "teaching"
      ? named
        ? t("companionWatchFramePage.teachingNamed", { name: assistantName })
        : t("companionWatchFramePage.teaching")
      : read.target.kind === "display"
        ? named
          ? t("companionWatchFramePage.sharingScreenNamed", {
              name: assistantName,
            })
          : t("companionWatchFramePage.sharingScreen")
        : named
          ? t("companionWatchFramePage.sharingWindowNamed", {
              name: assistantName,
            })
          : t("companionWatchFramePage.sharingWindow");
  return (
    <div
      className="companion-watch-frame-label"
      data-testid="companion-watch-frame-label"
      data-read={read.kind}
      style={style}
    >
      <span className="companion-watch-frame-label-dot" />
      {words}
    </div>
  );
}

/**
 * How many captures this window has watched arrive, which is not the same as
 * how many the session has taken.
 *
 * `captureCount` on the pushed state is a running total that outlives any one
 * window reading it. This window is opened with the session and main replays
 * its retained state into it, so it routinely meets a session already forty
 * reads in. A flash drawn off the value would present the last of those as a
 * capture happening now, which is the one thing this indicator must never do:
 * it is worth something only because a flash means the screen was read at
 * that moment.
 *
 * So a step counts only when it lands inside a session this window was already
 * watching. That covers both ways a total arrives without a capture behind it:
 * the first render, whatever the count is by then, and the jump from nothing
 * to a session already in progress. What is left is a count moving under a
 * session that was running a moment ago, which is a read that just happened.
 *
 * The result is a key rather than a flag, so each step remounts the element
 * and replays a one-shot animation. Zero is nothing observed yet, and it
 * returns to zero when the session ends.
 */
function useObservedCaptures(captureCount: number, watching: boolean): number {
  const seen = useRef({ captureCount, watching });
  const [observed, setObserved] = useState(0);
  useEffect(() => {
    const previous = seen.current;
    seen.current = { captureCount, watching };
    if (!watching) {
      setObserved(0);
      return;
    }
    if (previous.watching && captureCount > previous.captureCount) {
      setObserved((count) => count + 1);
    }
  }, [captureCount, watching]);
  return observed;
}

export function CompanionWatchFramePage() {
  const [state, setState] = useState<CompanionSurfaceState | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeCompanionState(setState);
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        setState(initial);
      }
    });
    return unsubscribe;
  }, []);

  // Read as the surface reads it: only a positive answer is a session, since
  // the alternative is framing a screen nobody is reading.
  const watching = state?.watching === true;
  // A target on the state is the share, since main sends the pick itself and
  // absence is nothing shared. The shell sizes this window to it; the page
  // only draws.
  const sharing = state?.screenShare !== undefined;
  // The border and the label are up for exactly the same reads, so one
  // answer serves both.
  const read = framedRead(watching, state?.screenShare);
  const lit = read !== null;
  // Counted against the watch session alone. `captureCount` is that session's
  // total and a share does not advance it, so a share left holding the frame
  // after a watch ended would sit on the last count that session reported and
  // flash for a read nobody took.
  const observedCaptures = useObservedCaptures(
    state?.captureCount ?? 0,
    watching,
  );

  // The assistant's colour, resolved exactly as the surface resolves it: the
  // running call's first, then what the app published with the character,
  // then the character's own palette. Left unset when none of them parse,
  // which hands the class its own default rather than dropping the custom
  // property and taking the border's colour with it.
  const accentHex = companionAccentHexFor(
    state?.call ?? null,
    state?.accentHex,
    state?.character,
  );
  const accentStyle =
    accentHex === undefined
      ? undefined
      : { ["--companion-ring-accent" as string]: accentHex };

  // The label's, on top of the accent: how far down the framed surface it
  // has to start to clear the menu bar, when a whole display is framed and
  // the bar draws over the top of this window. The shell reports it from
  // where it put the window; a shell that says nothing is one whose frame
  // has no bar over it, or predates the field, and the label sits against
  // the edge as it did.
  const inset = state?.frameInsetTop ?? 0;
  const labelStyle =
    inset > 0
      ? { ...accentStyle, ["--companion-frame-inset" as string]: `${inset}px` }
      : accentStyle;

  // Read the same way `watching` is, and for the sharper version of the same
  // reason: this one decides whether the window under the pointer takes the
  // click. Main makes the window interactive and says so here, so a shell
  // that never mentions it is one whose frame is click-through, and a drawing
  // layer mounted over that would swallow presses that go nowhere.
  const annotating = state?.annotating === true;

  // A mark is a fraction of the surface the frame encloses, and a watch
  // session outranks a share for the frame (`framedTarget` in
  // `companion-window.ts`). So the marks describe what this window is around
  // only while no session is being read beside the share. Main holds them to
  // the same terms; this is that fact read where it is drawn.
  const coachmarks = sharing && !watching ? (state?.coachmarks ?? []) : [];

  return (
    <div
      className="pointer-events-none h-screen w-screen bg-transparent"
      role="presentation"
      aria-hidden
    >
      {lit && (
        <div
          className="companion-watch-frame fixed inset-0"
          style={accentStyle}
        />
      )}
      {/* The sentence the edge cannot say. Drawn off the same read the edge
          is, so the two go up and come down together, and inside the same
          accent so the words and the border are one light. */}
      {read !== null && (
        <CompanionWatchFrameLabel
          read={read}
          assistantName={state?.assistantName ?? ""}
          style={labelStyle}
        />
      )}
      {/* One capture, as a single brightening of the same edge. The frame
          says the surface is being read, which is a state; this says it was
          read just now, which is an event, and the two need different
          treatments or the second is invisible inside the first. Keyed by the
          captures this window has watched arrive, so each one remounts the
          element and replays a one-shot animation. */}
      {watching && observedCaptures > 0 && (
        <div
          key={observedCaptures}
          className="companion-watch-frame-flash fixed inset-0"
          style={accentStyle}
        />
      )}
      {/* Drawn in the same accent as the edge around it, since the marks and
          the border say one thing about one session. The border may leave its
          colour to the class when nothing resolves; ink on a canvas cannot,
          so the default the class carries is named for it. */}
      {annotating && (
        <CompanionShareAnnotation ink={accentHex ?? COMPANION_DEFAULT_ACCENT} />
      )}
      {/* Above the user's own ink in the markup for the reason it is drawn at
          all: a mark says where to go next, and the user's marks are about
          where they have already been. Neither takes the mouse, so the order
          is about the eye alone. */}
      {coachmarks.length > 0 && (
        <CompanionCoachmarks
          marks={coachmarks}
          ink={accentHex ?? COMPANION_DEFAULT_ACCENT}
        />
      )}
    </div>
  );
}
