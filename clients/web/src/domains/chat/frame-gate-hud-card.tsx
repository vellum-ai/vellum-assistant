/**
 * The readout as a card: a fixed-width glass panel parked wherever its mount
 * puts it, holding the whole readout at once.
 *
 * The presentation for a window with room to spare. It costs 288px of width
 * and most of a column of height, which a desktop viewfinder has and a phone
 * does not; the narrow presentation lives in `frame-gate-hud-compact.tsx`.
 */

import type { CSSProperties } from "react";
import { cn } from "@vellumai/design-library";

import { CAMERA_MEDIA_GLASS_CLASS } from "@/domains/chat/voice/voice-room/camera-mode-paint";

import {
  FrameGateHudBody,
  type FrameGateHudViewProps,
} from "./frame-gate-hud-parts";

export interface FrameGateHudCardProps extends FrameGateHudViewProps {
  /** Positioning for the mount, which owns where the panel sits. */
  className?: string;
  /** Positioning that has to be computed, such as a safe-area inset. */
  style?: CSSProperties;
}

export function FrameGateHudCard({
  snapshot,
  surface,
  latest,
  className,
  style,
}: FrameGateHudCardProps) {
  return (
    <div
      data-slot="frame-gate-hud"
      data-testid="frame-gate-hud"
      style={style}
      className={cn(
        "w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg p-3",
        "flex flex-col gap-3 text-[11px] leading-tight shadow-lg",
        CAMERA_MEDIA_GLASS_CLASS,
        className,
      )}
    >
      <FrameGateHudBody snapshot={snapshot} surface={surface} latest={latest} />
    </div>
  );
}
