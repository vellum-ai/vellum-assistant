import type { Meta, StoryObj } from "@storybook/react-vite";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import { StreamingShimmerText } from "./streaming-shimmer-text";

/**
 * The chat streaming-state text treatment: an avatar-tinted gradient glint
 * sweeping across the loading label. In the app the accent comes from the
 * selected avatar color via the `--avatar-accent` CSS custom property; these
 * stories drive it explicitly through the `colorHex` override so every
 * palette option can be tried side by side.
 */

const AVATAR_COLORS = Object.fromEntries(
  BUNDLED_COMPONENTS.colors.map((c) => [c.id, c.hex]),
);

const meta: Meta<typeof StreamingShimmerText> = {
  title: "Chat/StreamingShimmerText",
  component: StreamingShimmerText,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    colorHex: {
      options: [undefined, ...Object.values(AVATAR_COLORS)],
      control: {
        type: "select",
        labels: {
          undefined: "neutral (no avatar color)",
          ...Object.fromEntries(
            BUNDLED_COMPONENTS.colors.map((c) => [c.hex, c.id]),
          ),
        },
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StreamingShimmerText>;

/** Playground — pick any avatar palette color from the control panel. */
export const Playground: Story = {
  args: {
    children: "Searching social media sites",
    colorHex: AVATAR_COLORS["orange"],
  },
  render: (args) => (
    <span className="text-[13px] font-medium text-[var(--content-secondary)]">
      <StreamingShimmerText {...args} />
    </span>
  ),
};

/** Every avatar color side by side, on the transcript's secondary text tone. */
export const AllAvatarColors: Story = {
  render: () => (
    <div className="flex flex-col gap-3 text-[13px] font-medium text-[var(--content-secondary)]">
      {BUNDLED_COMPONENTS.colors.map((c) => (
        <div key={c.id} className="flex items-center gap-3">
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-full"
            style={{ backgroundColor: c.hex }}
          />
          <StreamingShimmerText colorHex={c.hex}>
            {`Thinking about the next step (${c.id})`}
          </StreamingShimmerText>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="size-4 shrink-0 rounded-full border border-[var(--border-element)]"
        />
        <StreamingShimmerText>
          Thinking about the next step (neutral fallback)
        </StreamingShimmerText>
      </div>
    </div>
  ),
};

/** The exact loading labels the chat renders through the shimmer. */
export const ChatLoadingLabels: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-[13px] font-medium text-[var(--content-secondary)]">
      <StreamingShimmerText colorHex={AVATAR_COLORS["orange"]}>
        Thinking
      </StreamingShimmerText>
      <StreamingShimmerText colorHex={AVATAR_COLORS["orange"]}>
        Web Search
      </StreamingShimmerText>
      <span className="text-sm font-medium text-[var(--content-emphasised)]">
        <StreamingShimmerText colorHex={AVATAR_COLORS["orange"]}>
          Searching social media sites
        </StreamingShimmerText>
      </span>
    </div>
  ),
};
