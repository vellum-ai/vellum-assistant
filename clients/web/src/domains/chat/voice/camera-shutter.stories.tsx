/**
 * The shutter, judged where it ships: over a camera feed.
 *
 * Storybook has no `getUserMedia`, and the shutter never reads a stream anyway,
 * so a gradient stands in for the feed exactly as the design reference does.
 * The gradient runs from near-white to near-black in one frame on purpose: the
 * shutter carries no fill of its own, and the only interesting question about a
 * white ring is which frames it survives.
 *
 * The hold is exercised here too. Press and keep pressing (or focus the shutter
 * and hold Space): at 500ms `onHold` fires, and the release does not also take
 * a photo, which is the half of the gesture only this component can guarantee.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

// The morph timings and the capture keyframe are hand-written in the app
// stylesheet, which Storybook's preview.css does not pull in.
import "@/index.css";

import { CameraShutter, type CameraShutterProps } from "./camera-shutter";
import { CameraRowScene, overFakeFeed } from "./camera-story-feed";

const meta: Meta<typeof CameraShutter> = {
  title: "Chat/Voice/CameraShutter",
  component: CameraShutter,
  parameters: { layout: "fullscreen" },
  decorators: [overFakeFeed({ gap: 48 })],
  args: {
    ariaLabel: "Take photo",
    mode: "photo",
    onClick: () => {},
  },
  argTypes: {
    mode: {
      options: ["photo", "live"],
      control: { type: "inline-radio" },
      description:
        "The sampling policy the press acts on. A tap takes a photo; a tap while live stops the stream.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof CameraShutter>;

/**
 * Rest. White ring, white core, nothing behind it: legibility over a bright
 * frame is the surface's bottom scrim's job, and a dark backing here dulled
 * the one control meant to be the brightest thing on the screen.
 *
 * Press it. The crimson ring leaving the shutter is the capture feedback, and
 * it is deliberately not a full-screen white flash: this fires mid sentence,
 * and a strobing screen is hostile at the moment the user is still talking.
 */
export const Photo: Story = {};

/**
 * The frame is going. The core dips while the ring holds its size, so the
 * target under the user's thumb does not move between one shot and the next,
 * and the press is refused until the last one lands.
 */
export const Sending: Story = {
  args: { capturing: true, disabled: true },
};

/**
 * Streaming. The core shrinks past its target and settles back, which is the
 * record-button language every camera on the platform already uses: a crimson
 * dot that says "running, tap to stop" rather than "tap to take one".
 *
 * Flip the `mode` control to watch the morph both ways, which is the part the
 * overshoot exists for.
 */
export const Live: Story = {
  args: { mode: "live", ariaLabel: "Stop live" },
};

/**
 * The gesture the app ships, wired to its own state: hold to enter Live, tap to
 * leave.
 *
 * The two things to check are the two the component owns. The release of a hold
 * takes no photo, so the pulse fires on a tap and never at the end of a hold;
 * and a press that wanders more than 10px, or leaves the button, is a press
 * that never became one. Space holds too, which is the whole keyboard path.
 */
function HoldableShutter(args: CameraShutterProps) {
  const [live, setLive] = useState(false);
  const mode = live ? "live" : "photo";
  return (
    <CameraRowScene
      hint={{ mode }}
      shutter={{
        ...args,
        mode,
        ariaLabel: live ? "Stop live" : "Take photo",
        onHold: live ? undefined : () => setLive(true),
        onClick: () => {
          if (live) {
            setLive(false);
          }
        },
      }}
    />
  );
}

export const HoldForLive: Story = {
  render: (args) => <HoldableShutter {...args} />,
};

/**
 * The same two states under reduced motion, forced here through the class the
 * component applies from `useReducedMotion`. The overshoot is gone, the morph
 * is a linear 200ms, and the capture pulse stays: it is feedback rather than
 * decoration, and without it a press on an unchanged viewfinder is
 * indistinguishable from a dead button. Press either one.
 */
export const ReducedMotion: Story = {
  render: (args) => (
    <>
      <CameraShutter {...args} className="camera-shutter-calm" />
      <CameraShutter
        {...args}
        mode="live"
        ariaLabel="Stop live"
        className="camera-shutter-calm"
      />
    </>
  ),
};

/**
 * Where it actually sits: centred, with the real flash control to the left and
 * flip to the right, neither of them reachable by a thumb aimed at the middle.
 * The `mode` control still drives the shutter here, so the morph can be watched
 * with the row's weight around it.
 */
export const InTheCameraRow: Story = {
  render: (args) => <CameraRowScene shutter={args} />,
};
