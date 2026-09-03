/**
 * The frame gate's tuning readout in all three of its presentations, over a
 * stand-in for the camera feed.
 *
 * The readout is normally fed by a module-global record that only a running
 * camera writes, which is why the presentations take a snapshot as a prop and
 * the subscription stays in the container: a story can hand them a frame that
 * was judged in a particular way and read the drawing that follows from it.
 *
 * All three are here because the choice between them is a window width, and a
 * treatment that only appears at one width is one nobody can compare against
 * the others. The card is what a roomy window gets; the strip is what a phone
 * stands the card down to, and the sheet is what a tap on the strip brings up.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent } from "storybook/test";

import {
  CAMERA_STORY_FEED,
  CAMERA_STORY_FEED_DIM,
} from "@/domains/chat/voice/camera-story-feed";
import type {
  FrameGateDebugDecision,
  FrameGateDebugSnapshot,
} from "@/lib/camera/frame-gate-debug";

import { FrameGateHudCard } from "./frame-gate-hud-card";
import { FrameGateHudCompact } from "./frame-gate-hud-compact";

/**
 * A kept frame, at the size the readout draws one. The app holds object URLs
 * for real frames; a flat swatch is the same shape of data with nothing in it
 * that a public story should not carry.
 */
const KEPT_FRAME = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="36">' +
    '<rect width="48" height="36" fill="#a9927a"/></svg>',
)}`;

/** One judged frame, as the sampler records it. */
function decision(
  keep: boolean,
  atMs: number,
  overrides: Partial<FrameGateDebugDecision> = {},
): FrameGateDebugDecision {
  return {
    keep,
    reason: keep ? "novel" : "unchanged",
    motion: 0.018,
    novelty: keep ? 0.94 : 0.21,
    detail: 24.5,
    atMs,
    ...overrides,
  };
}

const KEPT = decision(true, 2_400);
const SKIPPED = decision(false, 2_480);

/**
 * A camera a few seconds into a Live run: a burst of skips behind it, two
 * frames kept, and the newest one kept on novelty.
 */
const SNAPSHOT: FrameGateDebugSnapshot = {
  surface: "voice",
  latest: KEPT,
  recent: [
    KEPT,
    decision(false, 2_320),
    decision(false, 2_240),
    decision(false, 2_160),
    decision(false, 2_080),
    decision(true, 1_600, { reason: "first", novelty: null }),
    decision(false, 1_520, { reason: "moving", motion: 0.12 }),
    decision(false, 1_440, { reason: "warmup", novelty: null }),
  ],
  reasonCounts: {
    warmup: 6,
    featureless: 0,
    first: 1,
    "rate-floor": 3,
    moving: 4,
    heartbeat: 0,
    novel: 2,
    unchanged: 11,
    forced: 0,
  },
  keeps: [
    { url: KEPT_FRAME, atMs: 2_400 },
    { url: KEPT_FRAME, atMs: 1_600 },
  ],
  total: 27,
};

const meta: Meta = {
  title: "Chat/FrameGateHud",
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj;

/**
 * The presentation a window with room to spare gets: everything at once, in a
 * fixed-width panel the mount parks in a corner.
 */
export const Card: Story = {
  render: () => (
    <div style={{ minHeight: 620, padding: 24, background: CAMERA_STORY_FEED }}>
      <FrameGateHudCard snapshot={SNAPSHOT} surface="voice" latest={KEPT} />
    </div>
  ),
};

/**
 * The strip, which is the whole readout while it is collapsed: the verdict and
 * the three meters at glyph size, in the slot the card would have filled.
 *
 * Read against the dim frame, which is the one a glass row has nothing to help
 * it on.
 */
export const Strip: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  render: () => (
    <div
      style={{
        position: "relative",
        minHeight: 620,
        background: CAMERA_STORY_FEED_DIM,
      }}
    >
      <FrameGateHudCompact
        snapshot={SNAPSHOT}
        surface="voice"
        latest={KEPT}
        className="absolute left-5 top-5"
      />
    </div>
  ),
};

/** The same strip with a skipped frame under it, so both verdicts are legible. */
export const StripOnASkip: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  render: () => (
    <div
      style={{
        position: "relative",
        minHeight: 620,
        background: CAMERA_STORY_FEED_DIM,
      }}
    >
      <FrameGateHudCompact
        snapshot={{ ...SNAPSHOT, latest: SKIPPED }}
        surface="voice"
        latest={SKIPPED}
        className="absolute left-5 top-5"
      />
    </div>
  ),
};

/**
 * What a tap on the strip brings up: the whole readout at the floor of the
 * box the readout was mounted in, which in the app is the room itself, with
 * the strip still overhead carrying the live meters.
 */
export const Sheet: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  render: () => (
    <div
      style={{
        position: "relative",
        minHeight: 720,
        background: CAMERA_STORY_FEED,
      }}
    >
      <FrameGateHudCompact
        snapshot={SNAPSHOT}
        surface="voice"
        latest={KEPT}
        className="absolute left-5 top-5"
      />
    </div>
  ),
  play: async () => {
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Show the frame gate readout",
      }),
    );
  },
};
