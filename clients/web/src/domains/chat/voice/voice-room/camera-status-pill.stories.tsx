/**
 * The camera-mode status pill, over a stand-in for the camera feed.
 *
 * Storybook has no `getUserMedia`, and the pill deliberately takes no stream:
 * it assumes media behind it rather than being handed one, so a gradient is a
 * complete substitute for the feed here (which is exactly how the design
 * reference fakes it).
 *
 * The design draws two words in the second slot, "Listening" or the assistant's
 * name. The stories below carry more than that on purpose: the pill is the only
 * session readout on screen while the viewfinder is up, so it renders the
 * session's whole surface label (`liveVoiceSurfaceLabelKey`), and Connecting,
 * Reconnecting, Thinking and Ending are states a user can sit in while a fixed
 * "Listening" would be telling them the mic is open.
 *
 * Both modes are here even though the app only ever opens the photo one: Live
 * is the design's second treatment, and a variant with no story is a treatment
 * nobody can look at.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

// The dot's blink is a hand-written keyframe in the app stylesheet, which
// Storybook's preview.css does not pull in.
import "@/index.css";

import {
  CAMERA_STORY_FEED_DIM,
  overFakeFeed,
} from "@/domains/chat/voice/camera-story-feed";

import { CameraStatusPill } from "./camera-status-pill";

const meta: Meta<typeof CameraStatusPill> = {
  title: "Chat/Voice/CameraStatusPill",
  component: CameraStatusPill,
  parameters: { layout: "fullscreen" },
  // The dim frame rather than the bright one: what the pill's glass has to
  // survive is a frame with nothing in it to read against.
  decorators: [
    overFakeFeed({
      direction: "column",
      gap: 16,
      background: CAMERA_STORY_FEED_DIM,
    }),
  ],
  args: {
    mode: "photo",
    voiceState: "idle",
    statusLabel: "Listening…",
    assistantName: "Luna",
  },
  argTypes: {
    mode: {
      options: ["photo", "live"],
      control: { type: "inline-radio" },
      description:
        "What the camera is doing. Photo is glass; Live fills with the capture accent.",
    },
    voiceState: {
      options: ["idle", "user", "assistant"],
      control: { type: "inline-radio" },
      description:
        "Whose voice is live. The room derives this; the pill only paints it.",
    },
    statusLabel: {
      options: [
        "Connecting…",
        "Reconnecting…",
        "Listening…",
        "Muted",
        "Thinking…",
        "Speaking…",
        "Ending…",
        "",
      ],
      control: { type: "select" },
      description:
        "What the session is doing, the catalog copy for `liveVoiceSurfaceLabelKey`. Empty for the phases that carry no label.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof CameraStatusPill>;

/** Nobody talking: a static half-lit dot, and the session still hearing you. */
export const Idle: Story = {};

/** The user talking. Same word, blinking white dot. */
export const UserSpeaking: Story = { args: { voiceState: "user" } };

/** The assistant answering: the rose accent, and her name in place of the word. */
export const AssistantSpeaking: Story = {
  args: { voiceState: "assistant", statusLabel: "Speaking…" },
};

/**
 * Mic off. The word says so; the dot is unchanged, because muting the mic
 * does not stop the assistant from talking.
 */
export const Muted: Story = { args: { statusLabel: "Muted" } };

/**
 * Opening the socket. The mic is not live during a connect, so the word must
 * not claim it is: this is the case a fixed "Listening" gets wrong.
 */
export const Connecting: Story = { args: { statusLabel: "Connecting…" } };

/** A dropped connection retrying, which the session labels apart from the first connect. */
export const Reconnecting: Story = { args: { statusLabel: "Reconnecting…" } };

/**
 * The turn closed and the assistant is working. Nothing is audible, so the dot
 * is static and the word is the session's, not "Listening".
 */
export const Thinking: Story = { args: { statusLabel: "Thinking…" } };

/** Graceful teardown, before the room unmounts. */
export const Ending: Story = { args: { statusLabel: "Ending…" } };

/**
 * A phase with no label at all (`idle`, `failed`). The mode word stands alone
 * rather than trailing a separator with nothing after it.
 */
export const NoLabel: Story = { args: { statusLabel: "" } };

/**
 * A configured name past any width the room can give it, at phone width, which
 * is where it has the least. The pill holds one line and stops at the width it
 * is allowed: the dot and "Photo" stay whole, and the name takes the ellipsis.
 */
export const LongAssistantName: Story = {
  globals: { viewport: { value: "sbMobile" } },
  args: {
    voiceState: "assistant",
    statusLabel: "Speaking…",
    assistantName:
      "Marguerite Vandersteen of the Northern Reaches, Third of Her Name",
  },
};

/**
 * Streaming rather than sampling. Filled with the capture accent, because "this
 * is going out continuously" is the one thing about the surface that has to be
 * legible without reading. Not reachable from the app yet: the room opens the
 * photo mode only.
 */
export const Live: Story = { args: { mode: "live" } };

/** Every combination the pill can be in, stacked, in both modes. */
export const StateMatrix: Story = {
  argTypes: {
    mode: { table: { disable: true } },
    voiceState: { table: { disable: true } },
    statusLabel: { table: { disable: true } },
  },
  render: (args) => (
    <>
      <CameraStatusPill {...args} voiceState="idle" statusLabel="Connecting…" />
      <CameraStatusPill {...args} voiceState="idle" statusLabel="Listening…" />
      <CameraStatusPill {...args} voiceState="user" statusLabel="Listening…" />
      <CameraStatusPill {...args} voiceState="idle" statusLabel="Thinking…" />
      <CameraStatusPill
        {...args}
        voiceState="assistant"
        statusLabel="Speaking…"
      />
      <CameraStatusPill {...args} voiceState="idle" statusLabel="Muted" />
      <CameraStatusPill {...args} voiceState="idle" statusLabel="Ending…" />
      {/* The live fill against the same frame, at the three states the mode is
          worth comparing in: nobody talking, the user talking, and the
          assistant answering. */}
      <CameraStatusPill
        {...args}
        mode="live"
        voiceState="idle"
        statusLabel="Listening…"
      />
      <CameraStatusPill
        {...args}
        mode="live"
        voiceState="user"
        statusLabel="Listening…"
      />
      <CameraStatusPill
        {...args}
        mode="live"
        voiceState="assistant"
        statusLabel="Speaking…"
      />
    </>
  ),
};

/**
 * Reduced motion.
 *
 * Not forceable from a story: it is an OS setting, read both by the keyframe's
 * own `prefers-reduced-motion` block and by the component's `useReducedMotion`.
 * Turn it on in the OS (macOS: Settings > Accessibility > Display > Reduce
 * motion) and reload: the dot in every state above holds still, fully lit, and
 * nothing else about the pill changes.
 */
export const ReducedMotionNote: Story = { args: { voiceState: "user" } };
