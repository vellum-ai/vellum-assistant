/**
 * The scenery every camera story is read against: the stand-in for the feed,
 * the captioned cell, and the control row the shutter and flash both sit in.
 *
 * Storybook has no `getUserMedia`, and none of the camera components takes a
 * stream: each assumes media behind it rather than being handed one, which is
 * what makes a gradient a complete substitute, and is how the design reference
 * fakes it too. One module rather than a copy per story file, so a frame that
 * stops being the honest test case stops being it everywhere at once, and so
 * the row's offsets are stated once outside the app.
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
import { CAMERA_WARM } from "./voice-room/camera-mode-paint";

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
 * thing to press. The fill comes off the same constant the real one reads, so
 * the stand-in cannot drift.
 */
function CameraRowFlipStandIn() {
  return (
    <span
      aria-hidden
      className="absolute right-[30px] size-13 rounded-full"
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
   * The width the row is read at. On its own it takes a phone's, which is what
   * the flanking offsets were drawn against; a composed screen passes `w-full`
   * instead, since in the app the row is as wide as the room it sits in and
   * the flanks ride that edge rather than a fixed one.
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
 * place is a story about the pair. The offsets are the design's, stated here
 * rather than in each story file.
 */
export function CameraRowScene({
  shutter = ROW_SHUTTER,
  flash,
  className,
}: CameraRowSceneProps) {
  return (
    <div
      className={cn(
        "relative flex w-[390px] items-center justify-center",
        className,
      )}
    >
      <CameraFlashControl
        {...ROW_FLASH}
        {...flash}
        onClick={() => {}}
        className="absolute left-11"
      />
      <CameraShutter {...shutter} />
      <CameraRowFlipStandIn />
    </div>
  );
}
