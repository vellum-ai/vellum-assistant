/**
 * The flash control, judged where it ships: over a camera feed.
 *
 * There is no `getUserMedia` in Storybook, and the control never reads a stream
 * anyway, so the "feed" is a gradient standing in for one. That is the honest
 * harness: the only thing the control needs from the video behind it is that it
 * is arbitrary and can be any brightness, which is the whole reason off is dark
 * glass with a light hairline and armed is near-white.
 *
 * The states are props, not store reads, so nothing here has to be seeded.
 * `Cycle` is the one to press: off, auto, on, off, in that order, which is the
 * contract the room's press is written against.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import {
  CameraRowFlipStandIn,
  overFakeFeed,
} from "@/domains/chat/voice/camera-story-feed";
import type { FlashMode } from "@/stores/voice-prefs-store";

import { CameraFlashControl, nextFlashMode } from "./camera-flash-control";

/** The accessible name each state carries, mirroring the room's catalog copy. */
const LABELS: Record<FlashMode, string> = {
  off: "Flash off",
  auto: "Flash auto",
  on: "Flash on",
};

const ORDER: FlashMode[] = ["off", "auto", "on"];

/** One state, captioned, so the three can be compared side by side. */
function StateCell({ mode }: { mode: FlashMode }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <CameraFlashControl
        mode={mode}
        ariaLabel={LABELS[mode]}
        autoBadge="A"
        onClick={() => {}}
      />
      <span className="font-mono text-[11px] text-white/70">{mode}</span>
    </div>
  );
}

const meta: Meta<typeof CameraFlashControl> = {
  title: "Chat/Voice/Camera Flash Control",
  component: CameraFlashControl,
  parameters: { layout: "fullscreen" },
  decorators: [overFakeFeed({ gap: 40 })],
};

export default meta;
type Story = StoryObj<typeof CameraFlashControl>;

/**
 * All three at once. The read to check is that off recedes into the chrome
 * around it while auto and on come forward: "the flash will fire" has to be
 * legible as a change in weight from arm's length, not as the difference
 * between two outlines.
 */
export const States: Story = {
  render: () => (
    <>
      {ORDER.map((mode) => (
        <StateCell key={mode} mode={mode} />
      ))}
    </>
  ),
};

/**
 * The order, pressable. Off, auto, on, off. Auto sits in the middle because it
 * is the mode most people want and the one they should reach in a single press
 * from rest, and on has to lead back to off or a lit camera has no way home.
 */
export const Cycle: Story = {
  render: () => <CycleScene />,
};

function CycleScene() {
  const [mode, setMode] = useState<FlashMode>("off");
  return (
    <div className="flex flex-col items-center gap-3">
      <CameraFlashControl
        mode={mode}
        ariaLabel={LABELS[mode]}
        autoBadge="A"
        onClick={() => setMode(nextFlashMode(mode))}
      />
      <span className="font-mono text-[11px] text-white/70">{mode}</span>
    </div>
  );
}

/**
 * Where it actually sits: left of the shutter, opposite flip. Not rendered at
 * all on the browser fallback path or on a native camera whose probe came back
 * without a capture-flash mode, which is most front cameras. There is no
 * disabled state to look at here on purpose. A control that cannot do anything
 * is a control the user has to press to discover that.
 */
export const InTheShutterRow: Story = {
  render: () => (
    <div className="relative flex w-[390px] items-center justify-center">
      <CameraFlashControl
        mode="auto"
        ariaLabel={LABELS.auto}
        autoBadge="A"
        onClick={() => {}}
        className="absolute left-11"
      />
      <span
        aria-hidden
        className="flex size-[84px] items-center justify-center rounded-full border-[2.5px] border-white"
      >
        <span className="size-16 rounded-full bg-white" />
      </span>
      <CameraRowFlipStandIn />
    </div>
  ),
};
