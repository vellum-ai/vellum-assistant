import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import {
  activateCompanionApp,
  getCompanionState,
  moveCompanionBy,
  setCompanionInteractive,
  startCompanionVoice,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import { sendVoiceActivityControl } from "@/runtime/desktop-voice-activity";
import type {
  CompanionGrowth,
  CompanionSurfaceState,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

/**
 * How far a press may travel and still count as a click.
 *
 * The surface is its own drag handle, so every press is a potential grab. A few
 * pixels of hand tremor between pressing the avatar and letting go must not
 * turn "take me back to Vellum" into a one-pixel nudge that does nothing.
 */
const DRAG_SLOP = 3;

/**
 * The companion surface inside its Electron canvas
 * (`clients/macos/src/main/companion-window.ts`).
 *
 * Standalone (no auth, no RootLayout) like the dictation overlay and Quick
 * Input, so it paints as soon as the window opens. The canvas is transparent
 * and much larger than the pill: the page paints only the pill and leaves the
 * rest of the window empty, which is what lets the expansion be CSS in a window
 * that never resizes.
 *
 * **The page owns interactivity.** The window is click-through so its mostly
 * empty canvas does not swallow presses meant for the desktop behind it, and
 * only the page knows where the pill is actually drawn, so it tells main when
 * the pointer is over the surface and main makes the window clickable for
 * exactly that long.
 *
 * **It draws the running call, and holds none of it.** The session lives in the
 * window with the chat layout in it; main holds the snapshot and pushes it here
 * with the rest of the surface's state, and presses go back out the same way.
 * That is what lets this window reload mid-call without the call noticing.
 */
export function CompanionSurfacePage() {
  const [growth, setGrowth] = useState<CompanionGrowth>("right");
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>();
  const [call, setCall] = useState<VoiceActivityState | null>(null);
  const [hovered, setHovered] = useState(false);
  // Mirrors what main was last told, so a pointer crossing the pill does not
  // send the same instruction on every mouse-move.
  const interactiveRef = useRef(false);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // Screen coordinates of the last drag frame, or null when not dragging.
  // Screen rather than client: the window moves under the cursor, so client
  // coordinates barely change while screen ones track the hand exactly.
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // Where the current press started, and whether it has travelled far enough to
  // be a drag rather than a click. Every press starts as both: the surface is
  // its own drag handle, so a press on the avatar is a grab until the hand
  // moves, and a click once it lifts without having moved.
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  useEffect(() => {
    const apply = (state: CompanionSurfaceState) => {
      setGrowth(state.growth);
      setAvatarSrc(
        state.avatarBase64 === undefined
          ? undefined
          : `data:image/png;base64,${state.avatarBase64}`,
      );
      setCall(state.call);
    };
    const unsubscribe = subscribeCompanionState(apply);
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        apply(initial);
      }
    });
    return unsubscribe;
  }, []);

  // Never leave the window clickable behind us: an unmount mid-hover would
  // otherwise strand a transparent canvas that eats every click on that corner
  // of the screen.
  useEffect(() => {
    return () => {
      setCompanionInteractive(false);
    };
  }, []);

  const setInteractive = (next: boolean) => {
    if (interactiveRef.current === next) {
      return;
    }
    interactiveRef.current = next;
    setCompanionInteractive(next);
  };

  /**
   * Hit-test the pointer against the pill on every move.
   *
   * Not `mouseenter`: a click-through window delivers forwarded mouse-move and
   * little else, so entering and leaving have to be derived from coordinates.
   * `dictation-overlay-page.tsx` measures its stop button the same way for the
   * same reason. The rect is read live rather than cached because the pill
   * changes width as it expands, and a stale rect would collapse the surface
   * the moment it finished growing.
   */
  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    // A drag owns the pointer until it is released. Hit-testing through it
    // would collapse the surface the moment the cursor left the pill, which is
    // most of any drag worth making.
    if (dragRef.current !== null) {
      const { x, y } = dragRef.current;
      moveCompanionBy(event.screenX - x, event.screenY - y);
      dragRef.current = { x: event.screenX, y: event.screenY };
      const origin = pressOriginRef.current;
      if (
        origin !== null &&
        Math.abs(event.screenX - origin.x) +
          Math.abs(event.screenY - origin.y) >
          DRAG_SLOP
      ) {
        draggedRef.current = true;
      }
      return;
    }
    const pill = pillRef.current;
    if (!pill) {
      return;
    }
    const rect = pill.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    setHovered(inside);
    setInteractive(inside);
  };

  // **A running call outranks the pointer.** The surface is otherwise a circle
  // that only becomes a pill while it is being pointed at, and a live
  // microphone that hides itself the moment the pointer leaves is a live
  // microphone the user cannot see. So the call holds the pill open, and
  // hovering it changes nothing: the controls it wants are already there.
  const phase: CompanionSurfacePhase =
    call !== null ? "call" : hovered ? "hover" : "resting";

  // The avatar's own colour, which arrives with the session. It is `""` until
  // the avatar resolves and the contract makes no promise it parses, so
  // anything that is not an obvious `#RRGGBB` falls back to the component's
  // default rather than being handed to CSS, where an invalid value silently
  // drops the custom property and takes the glyph's colour with it.
  const accentHex =
    call !== null && /^#[0-9a-f]{6}$/i.test(call.accentHex)
      ? call.accentHex
      : undefined;

  return (
    <div
      className="relative h-screen w-screen bg-transparent"
      onMouseMove={onMouseMove}
      onMouseUp={() => {
        dragRef.current = null;
      }}
      onMouseLeave={() => {
        // The pointer left the canvas entirely, which mouse-move cannot report.
        // A drag ends here too: the button came up somewhere we cannot see.
        dragRef.current = null;
        setHovered(false);
        setInteractive(false);
      }}
    >
      <CompanionSurface
        phase={phase}
        growth={growth}
        avatarSrc={avatarSrc}
        accentHex={accentHex}
        call={call ?? undefined}
        rootRef={pillRef}
        onSurfaceMouseDown={(event) => {
          dragRef.current = { x: event.screenX, y: event.screenY };
          pressOriginRef.current = { x: event.screenX, y: event.screenY };
          draggedRef.current = false;
        }}
        // A press that never became a drag. The window comes forward on the
        // conversation this surface belongs to; main decides what that means.
        onAvatarClick={() => {
          if (draggedRef.current) {
            return;
          }
          activateCompanionApp();
        }}
        // The press leaves this window immediately: the session lives in the
        // renderer holding the chat layout, and this page only asks for one.
        // What comes back is `call`, once that renderer has a session to
        // report.
        onTalk={startCompanionVoice}
        // Out through main and back down into whichever renderer holds the
        // session. This page has no session to act on: it draws one.
        onControl={(action, requestId) => {
          sendVoiceActivityControl(
            requestId === undefined ? { action } : { action, requestId },
          );
        }}
      />
    </div>
  );
}
