/**
 * The scenery every camera story is read against: the stand-in for the feed,
 * the captioned cell, and the control row the shutter and flash both sit in.
 *
 * Storybook has no `getUserMedia`, and none of the camera components takes a
 * stream: each assumes media behind it rather than being handed one, which is
 * what makes a gradient a complete substitute, and is how the design reference
 * fakes it too. One module rather than a copy per story file, so a frame that
 * stops being the honest test case stops being it everywhere at once, and so
 * the row is composed once outside the app.
 *
 * Story-local sample content standing in for camera video. Nothing here is app
 * styling, and nothing outside a `.stories.tsx` file imports it.
 */

import type { Decorator } from "@storybook/react-vite";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@vellumai/design-library";

import { CameraShutter, type CameraShutterProps } from "./camera-shutter";
import {
  CameraFlashControl,
  type CameraFlashControlProps,
} from "./voice-room/camera-flash-control";
import {
  CameraShutterHint,
  type CameraShutterHintProps,
} from "./voice-room/camera-shutter-hint";
import { CAMERA_WARM } from "./voice-room/camera-mode-paint";
import {
  CAMERA_ROW_FLANK_INSET,
  VOICE_ROOM_CONTROL_SIZE_CLASS,
} from "./voice-room/voice-room-layout";

/**
 * Two stops of brightness in one frame. A control that only has to survive
 * mid-grey is not being tested, and camera chrome carries no fill it can fall
 * back on, so the question every story here asks is which frames it survives.
 */
export const CAMERA_STORY_FEED =
  "linear-gradient(115deg, #f4efe6 0%, #a9927a 38%, #2c2620 72%, #0b0a09 100%)";

/**
 * A dim room lit from the top left: the case the status pill's glass has to
 * hold up over, where the bright frame above tells you nothing.
 */
export const CAMERA_STORY_FEED_DIM =
  "radial-gradient(120% 90% at 22% 8%, #6d5c4d 0%, #3a3129 42%, #17130f 100%)";

export interface FakeFeedOptions {
  /** How the story's own cells lay out inside the frame. */
  direction?: "row" | "column";
  /** Space between those cells, in pixels. */
  gap?: number;
  /** Which frame to read against. Defaults to {@link CAMERA_STORY_FEED}. */
  background?: string;
}

/** Puts a story over a stand-in feed. */
export function overFakeFeed({
  direction = "row",
  gap = 32,
  background = CAMERA_STORY_FEED,
}: FakeFeedOptions = {}): Decorator {
  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction,
    alignItems: "center",
    justifyContent: "center",
    gap,
    minHeight: 260,
    padding: "56px 24px",
    background,
  };

  return (Story) => (
    <div style={style}>
      <Story />
    </div>
  );
}

/** One control with the word for what it is, so a set can be read side by side. */
export function ToneCell({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      {children}
      <span className="font-mono text-[11px] text-white/70">{caption}</span>
    </div>
  );
}

/**
 * Flip, at its place in the shutter row, drawn rather than rendered: the
 * stories that show the row are about the two controls that change how the
 * next photo comes out, and a live control off to the side would be a third
 * thing to press. The fill, the circle and the inset all come off the same
 * constants the real one reads, so the stand-in cannot drift.
 */
function CameraRowFlipStandIn() {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute right-[var(--camera-flank-inset)] rounded-full",
        VOICE_ROOM_CONTROL_SIZE_CLASS,
      )}
      style={{ background: CAMERA_WARM }}
    />
  );
}

const ROW_SHUTTER: CameraShutterProps = {
  ariaLabel: "Take photo",
  onClick: () => {},
};

const ROW_FLASH: Pick<
  CameraFlashControlProps,
  "mode" | "ariaLabel" | "autoBadge"
> = {
  mode: "auto",
  ariaLabel: "Flash auto",
  autoBadge: "A",
};

export interface CameraRowSceneProps {
  /** The shutter in the middle. Defaults to a photo shutter at rest. */
  shutter?: CameraShutterProps;
  /** The flash control to its left. Defaults to auto, the state with the badge. */
  flash?: Pick<CameraFlashControlProps, "mode" | "ariaLabel">;
  /**
   * The caption above the row, where the app offers Live. Absent by default,
   * matching the room: the hint is shown only where the hold does something.
   */
  hint?: CameraShutterHintProps;
  /**
   * The width the row is read at. On its own it takes a phone's, which is the
   * width the row is designed at; a composed screen passes `w-full` instead,
   * since in the app the row is as wide as the room it sits in and the flanks
   * ride that edge rather than a fixed one.
   */
  className?: string;
}

/**
 * The row as it ships, at a phone's width: flash on the left, flip on the
 * right, shutter between them, neither flank reachable by a thumb aimed at the
 * middle.
 *
 * The shutter and the flash are the real components, since both are
 * presentational and read nothing from a store, so a story about either one in
 * place is a story about the pair. The flanks' inset and the circle they share
 * are the room's own, imported from `voice-room-layout.ts`, the module the room
 * reads them from, so the row cannot drift from the surface it stands in for.
 */
export function CameraRowScene({
  shutter = ROW_SHUTTER,
  flash,
  hint,
  className,
}: CameraRowSceneProps) {
  return (
    // A column at the row's own width, so the hint sits over the shutter at
    // the gap the room gives the pair and the flanks still ride the outer
    // edge. Without a hint it is the row it always was.
    <div
      className={cn("flex w-[390px] flex-col items-center gap-3", className)}
    >
      {hint ? <CameraShutterHint {...hint} /> : null}
      <div
        className="relative flex w-full items-center justify-center"
        style={
          { "--camera-flank-inset": CAMERA_ROW_FLANK_INSET } as CSSProperties
        }
      >
        <CameraFlashControl
          {...ROW_FLASH}
          {...flash}
          onClick={() => {}}
          className="absolute left-[var(--camera-flank-inset)]"
        />
        <CameraShutter {...shutter} />
        <CameraRowFlipStandIn />
      </div>
    </div>
  );
}
