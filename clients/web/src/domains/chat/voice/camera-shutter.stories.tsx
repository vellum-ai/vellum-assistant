/**
 * The shutter, judged where it ships: over a camera feed.
 *
 * Storybook has no `getUserMedia`, and the shutter never reads a stream anyway,
 * so a gradient stands in for the feed exactly as the design reference does.
 * The gradient runs from near-white to near-black in one frame on purpose: the
 * shutter carries no fill of its own any more, and the only interesting
 * question about a white ring is which frames it survives.
 *
 * `Live` is the one state the app cannot reach. Capture is photo-only until
 * frame streaming ships; the state is part of this component's contract, and
 * this is where it is exercised.
 */

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

// The morph timings and the capture keyframe are hand-written in the app
// stylesheet, which Storybook's preview.css does not pull in.
import "@/index.css";

import { CameraShutter } from "./camera-shutter";

/**
 * A frame to read the shutter against: two stops of brightness, because a
 * control that only has to survive mid-grey is not being tested. Story-local
 * sample content standing in for camera video, not app styling.
 */
const overFakeFeed: Decorator = (Story) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 48,
      minHeight: 260,
      padding: "56px 32px",
      background:
        "linear-gradient(115deg, #f4efe6 0%, #a9927a 38%, #2c2620 72%, #0b0a09 100%)",
    }}
  >
    <Story />
  </div>
);

const meta: Meta<typeof CameraShutter> = {
  title: "Chat/Voice/CameraShutter",
  component: CameraShutter,
  parameters: { layout: "fullscreen" },
  decorators: [overFakeFeed],
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
 * Where it actually sits: centred, with flash to the left and flip to the
 * right, neither of them reachable by a thumb aimed at the middle. The two
 * flanking marks are story-local stand-ins at the design's offsets.
 */
export const InTheCameraRow: Story = {
  render: (args) => (
    <div className="relative flex w-[390px] items-center justify-center">
      <span className="absolute left-11 size-[46px] rounded-full border border-white/20 bg-black/42" />
      <CameraShutter {...args} />
      <span className="absolute right-[30px] size-13 rounded-full bg-[rgba(90,74,64,0.75)]" />
    </div>
  ),
};
