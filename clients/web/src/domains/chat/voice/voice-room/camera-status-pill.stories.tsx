/**
 * The camera-mode status pill, over a stand-in for the camera feed.
 *
 * Storybook has no `getUserMedia`, and the pill deliberately takes no stream:
 * it assumes media behind it rather than being handed one, so a gradient is a
 * complete substitute for the feed here (which is exactly how the design
 * reference fakes it). Swapping in a real viewfinder later costs nothing.
 */

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

// The dot's blink is a hand-written keyframe in the app stylesheet, which
// Storybook's preview.css does not pull in.
import "@/index.css";

import { CameraStatusPill } from "./camera-status-pill";

/**
 * A frame to read the pill against: a dim room, lit from the top left, which
 * is the case the pill's glass has to survive. Story-local sample content
 * standing in for camera video, not app styling.
 */
const overFakeFeed: Decorator = (Story) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 16,
      padding: "56px 24px",
      background:
        "radial-gradient(120% 90% at 22% 8%, #6d5c4d 0%, #3a3129 42%, #17130f 100%)",
    }}
  >
    <Story />
  </div>
);

const meta: Meta<typeof CameraStatusPill> = {
  title: "Chat/Voice/CameraStatusPill",
  component: CameraStatusPill,
  parameters: { layout: "fullscreen" },
  decorators: [overFakeFeed],
  args: { voiceState: "idle", muted: false, assistantName: "Luna" },
  argTypes: {
    voiceState: {
      options: ["idle", "user", "assistant"],
      control: { type: "inline-radio" },
      description:
        "Whose voice is live. The room derives this; the pill only paints it.",
    },
    muted: { description: "The mic is off, which only the word reports." },
  },
};

export default meta;
type Story = StoryObj<typeof CameraStatusPill>;

/** Nobody talking: a static half-lit dot, and the session still hearing you. */
export const Idle: Story = {};

/** The user talking. Same word, blinking white dot. */
export const UserSpeaking: Story = { args: { voiceState: "user" } };

/** The assistant answering: the rose accent, and her name in place of the word. */
export const AssistantSpeaking: Story = { args: { voiceState: "assistant" } };

/**
 * Mic off. The word says so; the dot is unchanged, because muting the mic
 * does not stop the assistant from talking.
 */
export const Muted: Story = { args: { muted: true } };

/**
 * A name long enough to test the claim that the pill never wraps: the floor
 * width stops the short words from shuffling it, and `nowrap` stops the long
 * ones from folding it into two lines.
 */
export const LongAssistantName: Story = {
  args: { voiceState: "assistant", assistantName: "Marguerite Vandersteen" },
};

/**
 * Every combination the pill can be in, stacked. Photo is the only mode that
 * ships here; Live lands with the vision-mode workstream.
 */
export const StateMatrix: Story = {
  argTypes: { voiceState: { table: { disable: true } } },
  render: (args) => (
    <>
      <CameraStatusPill {...args} voiceState="idle" />
      <CameraStatusPill {...args} voiceState="user" />
      <CameraStatusPill {...args} voiceState="assistant" />
      <CameraStatusPill {...args} voiceState="idle" muted />
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
