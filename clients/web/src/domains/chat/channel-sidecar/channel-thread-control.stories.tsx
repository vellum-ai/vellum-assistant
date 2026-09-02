import { useEffect, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DISCORD_TARGET,
  SLACK_TARGET,
} from "@/domains/chat/channel-sidecar/channel-sidecar-story-fixtures";
import { useViewerStore } from "@/stores/viewer-store";

import { ChannelThreadControl } from "./channel-thread-control";

/**
 * Top-bar control of a channel-bound conversation: the toggle into the
 * read-only channel drawer, in the slot where the source-link pill sits with
 * the sidecar flag off.
 *
 * The open/closed state lives in the real viewer store, which the control
 * itself reads and writes, so clicking it here toggles `aria-expanded` and
 * the pressed treatment exactly as in the app (the drawer itself belongs to
 * the chat layout and is not mounted here; see `Chat/ChannelSidecar` for the
 * two together). The decorator frames it on the header's `--surface-base`
 * backdrop, where its ghost chrome is legible, and closes any drawer state a
 * story's clicks left behind.
 */
/**
 * Owns the between-story cleanup. The viewer store is shared across stories,
 * so on unmount this closes whatever a story's clicks opened and the next
 * story starts from the app's resting state. A component rather than logic in
 * the decorator callback, so the hook runs in a component render.
 */
function ViewerStoreCleanup({ children }: { children: ReactNode }) {
  useEffect(
    () => () => {
      useViewerStore.getState().reconcileChannelTranscript(null);
    },
    [],
  );
  return <>{children}</>;
}

const meta: Meta<typeof ChannelThreadControl> = {
  title: "Chat/ChannelThreadControl",
  component: ChannelThreadControl,
  args: {
    target: SLACK_TARGET,
  },
  decorators: [
    (Story) => (
      <ViewerStoreCleanup>
        <div
          className="flex items-center gap-2 rounded-md p-6"
          style={{ background: "var(--surface-base)" }}
        >
          <Story />
        </div>
      </ViewerStoreCleanup>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ChannelThreadControl>;

/** Slack thread: brand glyph, channel-named label, panel affordance. */
export const Default: Story = {};

/**
 * Any other channel renders from the same presentation registry; nothing
 * about the control is Slack-specific.
 */
export const Discord: Story = {
  args: { target: DISCORD_TARGET },
};

/** Narrow viewports get the icon alone, matching the pill this slot held. */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
