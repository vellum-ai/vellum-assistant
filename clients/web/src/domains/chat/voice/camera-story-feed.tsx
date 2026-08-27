/**
 * The stand-in for the camera feed that every camera story is read against.
 *
 * Storybook has no `getUserMedia`, and none of the camera components takes a
 * stream: each assumes media behind it rather than being handed one, which is
 * what makes a gradient a complete substitute, and is how the design reference
 * fakes it too. One module rather than a copy per story file, so a frame that
 * stops being the honest test case stops being it everywhere at once.
 *
 * Story-local sample content standing in for camera video. Nothing here is app
 * styling, and nothing outside a `.stories.tsx` file imports it.
 */

import type { Decorator } from "@storybook/react-vite";
import type { CSSProperties } from "react";

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

/**
 * Flip, at its place in the shutter row, drawn rather than rendered: the
 * stories that show the row are about the control in the middle of it, and a
 * live control off to the side would be a second thing to press. The fill comes
 * off the same constant the real one reads, so the stand-in cannot drift.
 */
export function CameraRowFlipStandIn() {
  return (
    <span
      aria-hidden
      className="absolute right-[30px] size-13 rounded-full"
      style={{ background: CAMERA_WARM }}
    />
  );
}
