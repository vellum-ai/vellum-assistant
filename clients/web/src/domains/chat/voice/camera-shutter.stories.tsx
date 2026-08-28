/**
 * The shutter, judged where it ships: over a camera feed.
 *
 * Storybook has no `getUserMedia`, and the shutter never reads a stream anyway,
 * so a gradient stands in for the feed exactly as the design reference does.
 * The gradient runs from near-white to near-black in one frame on purpose: the
 * shutter carries no fill of its own, and the only interesting question about a
 * white ring is which frames it survives.
 *
 * `Live` is the one state the app cannot reach, since the capture path is
 * photo-only. It is part of this component's contract, and this is where it is
 * exercised.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

// The morph timings and the capture keyframe are hand-written in the app
// stylesheet, which Storybook's preview.css does not pull in.
import "@/index.css";

import { CameraShutter } from "./camera-shutter";
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
        "The sampling policy the press acts on. Live is unreachable in the app.",
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
 * Not reachable in the app. Flip the `mode` control to watch the morph both
 * ways, which is the part the overshoot exists for.
 */
export const Live: Story = {
  args: { mode: "live", ariaLabel: "Stop live" },
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
