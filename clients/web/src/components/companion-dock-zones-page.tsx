/**
 * The four edges a call's bar can be dropped on, shown while the bar is being
 * dragged mid-call.
 *
 * Drawn in its own click-through window the size of the display's work area,
 * which the macOS shell opens on the first move of such a drag, moves with
 * the drag from display to display, and closes on the release
 * (`clients/macos/src/main/companion-window.ts`). The bar itself is a window
 * the size of a pill; the edges are the display's, so they need a window the
 * display's size.
 *
 * All four are shown at once, because the drag is a choice between them and
 * a choice is shown whole. The one the release would land on is lit, so the
 * hand knows where the bar is going before it lets go. Which one that is
 * arrives on the pushed state (`docking`), decided by main from where the bar
 * actually is, so the edge that lights and the edge the bar lands on cannot
 * come apart.
 *
 * **It draws the choice and holds none of it.** Nothing here takes the
 * pointer: the page has no way to know where the hand is and does not need
 * one. Decoration on a desktop it does not own, like the watch frame.
 */

import { useEffect, useState, type CSSProperties } from "react";

import {
  companionAccentHexFor,
  COMPANION_DEFAULT_ACCENT,
} from "@/components/companion-accent";
import {
  getCompanionState,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import {
  COMPANION_DOCKS,
  type CompanionDock,
  type CompanionSurfaceState,
} from "@vellumai/ipc-contract";

/**
 * How far in from the display's edge a zone reaches, in points.
 *
 * About the bar's own thickness: deep enough to read as a place rather than
 * a line, and shallow enough to stay a rim of the display rather than a band
 * across it. A zone is where the bar is going, not where the drag is
 * allowed, and the drop snaps to the nearest edge from anywhere.
 */
export const DOCK_ZONE_DEPTH = 44;

/**
 * How far a zone runs along its edge, in points.
 *
 * The middle of the edge and not the whole of it, because the middle is
 * where the bar lands: a drop docks the bar to the centre of the nearest
 * edge, and a zone running corner to corner would promise a whole side the
 * bar never uses. About the length of the bar with the creature beside it,
 * so the lit zone is the size of the thing about to land in it.
 */
export const DOCK_ZONE_LENGTH = 360;

/** The room a zone keeps from the display's edge. */
const DOCK_ZONE_INSET = 10;

/** Where one edge's zone sits: centred on its edge, a rim's depth in. */
const zoneEdges = (dock: CompanionDock): CSSProperties => {
  const inset = DOCK_ZONE_INSET;
  const depth = DOCK_ZONE_DEPTH;
  const length = DOCK_ZONE_LENGTH;
  switch (dock) {
    case "top":
      return {
        top: inset,
        left: "50%",
        translate: "-50% 0",
        width: length,
        height: depth,
      };
    case "bottom":
      return {
        bottom: inset,
        left: "50%",
        translate: "-50% 0",
        width: length,
        height: depth,
      };
    case "left":
      return {
        left: inset,
        top: "50%",
        translate: "0 -50%",
        height: length,
        width: depth,
      };
    case "right":
      return {
        right: inset,
        top: "50%",
        translate: "0 -50%",
        height: length,
        width: depth,
      };
  }
};

export function CompanionDockZonesPage() {
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

  // The window exists only while a drag is in flight, but the state it is
  // pushed is the surface's whole state, and one between drags says nothing
  // is being dragged. Drawn only on a positive answer, so a window main has
  // not closed yet shows nothing rather than four dark edges.
  const docking = state?.docking;
  if (docking === undefined) {
    return null;
  }

  // The assistant's colour, resolved exactly as the surface resolves it, so
  // the edge the bar lands on is lit in the colour the bar itself is ringed
  // in.
  const accentHex = companionAccentHexFor(
    state?.call ?? null,
    state?.accentHex,
    state?.character,
  );
  const accent = accentHex ?? COMPANION_DEFAULT_ACCENT;

  return (
    <div
      className="pointer-events-none relative h-screen w-screen bg-transparent select-none"
      data-testid="companion-dock-zones"
      // The one place the colour is stated, so a test can read it and the
      // four zones cannot disagree about it.
      style={{ ["--companion-ring-accent" as string]: accent }}
      aria-hidden
    >
      {COMPANION_DOCKS.map((dock) => {
        const armed = dock === docking;
        return (
          <div
            key={dock}
            className="absolute rounded-2xl transition-[background-color,border-color,box-shadow] duration-150"
            data-testid="companion-dock-zone"
            data-dock={dock}
            data-armed={armed ? "true" : "false"}
            style={{
              ...zoneEdges(dock),
              // Lit against a wallpaper of any colour: a tint of the accent
              // for the place, and the accent itself for its edge. The armed
              // one is the same shape with the light turned up, so the eye
              // reads four places and one answer rather than four different
              // things.
              backgroundColor: `color-mix(in srgb, var(--companion-ring-accent) ${armed ? 26 : 9}%, transparent)`,
              border: `1.5px ${armed ? "solid" : "dashed"} color-mix(in srgb, var(--companion-ring-accent) ${armed ? 90 : 45}%, transparent)`,
              boxShadow: armed
                ? "0 0 24px color-mix(in srgb, var(--companion-ring-accent) 45%, transparent), inset 0 0 24px color-mix(in srgb, var(--companion-ring-accent) 25%, transparent)"
                : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
