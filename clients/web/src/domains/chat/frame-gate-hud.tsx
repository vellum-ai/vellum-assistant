/**
 * The frame gate's tuning readout: what the last frame scored, which of the
 * gate's checks decided it, and sliders for the thresholds those checks read.
 *
 * This module is the container. It holds the subscription to the debug record
 * and the two questions that decide whether anything is drawn at all; the
 * drawing itself belongs to the presentations beside it, which take a snapshot
 * as props and so can be put in a story with one seeded by hand.
 *
 * One container serves both camera surfaces. Each mount names the surface it
 * belongs to and renders nothing unless that surface is the one currently
 * feeding the gate, so the composer's tile and the voice room's viewfinder can
 * both mount a readout without ever putting two on screen.
 *
 * ## Which presentation
 *
 * Two, and the question between them is how much room the mount has: the card
 * is 288px wide and nearly a column tall, which is a corner of a desktop
 * viewfinder and most of a phone's. That is the window-size axis, so the branch
 * reads `useIsMobile()` and not the pointer or the platform, per
 * `docs/PLATFORM_ADAPTATION.md`: a desktop window dragged narrow has the same
 * shortage of room as a handset, and a roomy tablet has none of it whichever
 * way it is being touched. It is that hook rather than a query of this
 * component's own, so the app has one answer to "is this a narrow window"
 * rather than a second threshold beside the shared one, and it is JavaScript
 * rather than a `max-md:` class because the two presentations are different
 * components with different state, which no class can express.
 *
 * Only a mount that says so collapses. Whether a readout may stand down to a
 * strip is a fact about what surrounds it, which the mount knows and this
 * component does not: the voice room's readout sits over a full-bleed
 * viewfinder that a card would eat, and the composer's sits beside a corner
 * tile in a layout that is not the subject here.
 *
 * ## What a render costs
 *
 * The readout re-renders once per animation frame while a camera is open,
 * which is what a live readout is. It is a leaf with nothing under it, mounted
 * only for a session that has turned the readout on, and it renders null the
 * rest of the time, so the cost is confined to this subtree and to the sessions
 * asking for it.
 */

import { useSyncExternalStore, type CSSProperties } from "react";

import { useCameraGateHudEnabled } from "@/hooks/use-camera-gate-hud";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  getFrameGateDebugSnapshot,
  subscribeFrameGateDebug,
  type FrameGateDebugDecision,
  type FrameGateDebugSurface,
} from "@/lib/camera/frame-gate-debug";

import { FrameGateHudCard } from "./frame-gate-hud-card";
import { FrameGateHudCompact } from "./frame-gate-hud-compact";

export interface FrameGateHudProps {
  /** Which camera this mount belongs to. */
  surface: FrameGateDebugSurface;
  /**
   * Whether this mount may stand down to a strip where the window is too
   * narrow for the card. Off by default: a mount that has not said its
   * surroundings can spare the room keeps the card everywhere.
   */
  collapsible?: boolean;
  /** Positioning for the mount, which owns where the readout sits. */
  className?: string;
  /** Positioning that has to be computed, such as a safe-area inset. */
  style?: CSSProperties;
}

export function FrameGateHud({
  surface,
  collapsible = false,
  className,
  style,
}: FrameGateHudProps) {
  const enabled = useCameraGateHudEnabled();
  const narrow = useIsMobile();
  const snapshot = useSyncExternalStore(
    subscribeFrameGateDebug,
    getFrameGateDebugSnapshot,
    getFrameGateDebugSnapshot,
  );

  const latest: FrameGateDebugDecision | null = snapshot.latest;
  if (!enabled || snapshot.surface !== surface || !latest) {
    return null;
  }

  if (collapsible && narrow) {
    return (
      <FrameGateHudCompact
        snapshot={snapshot}
        surface={surface}
        latest={latest}
        className={className}
        style={style}
      />
    );
  }

  return (
    <FrameGateHudCard
      snapshot={snapshot}
      surface={surface}
      latest={latest}
      className={className}
      style={style}
    />
  );
}
