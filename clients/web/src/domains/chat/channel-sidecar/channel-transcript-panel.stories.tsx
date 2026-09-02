import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import {
  DISCORD_TARGET,
  SLACK_SPARSE_ENTRIES,
  SLACK_TARGET,
  SLACK_THREAD_ENTRIES,
} from "@/domains/chat/channel-sidecar/channel-sidecar-story-fixtures";

import { ChannelTranscriptPanelView } from "./channel-transcript-panel-view";

/**
 * The read-only channel drawer, mounted in the real side drawer.
 *
 * The subject is `ChannelTranscriptPanelView`, the prop-driven surface the
 * production `ChannelTranscriptPanel` container renders after deriving the
 * thread from the live stores; these stories pass the same shapes as
 * fixtures, so the pixels are the shipped ones.
 *
 * `referencedEntryId` is the drawer's one piece of interactive state: which
 * row is staged on the Vellum composer. In production it lives in the
 * single-slot `channel-reference-store`; here the arg owns it, written back
 * through `useArgs` so picking "Reference in Vellum" on a row stages it,
 * picking it again clears it, and the Controls panel stays in sync. For the
 * whole staging round trip against the real store and chip, see the
 * `Chat/ChannelSidecar` stories.
 */
const meta: Meta<typeof ChannelTranscriptPanelView> = {
  title: "Chat/ChannelTranscriptPanel",
  component: ChannelTranscriptPanelView,
  parameters: { layout: "fullscreen" },
  args: {
    sidecarRef: {
      conversationId: SLACK_TARGET.conversationId,
      channelId: SLACK_TARGET.channelId,
    },
    threadName: SLACK_TARGET.threadName,
    sourceHref: SLACK_TARGET.sourceHref,
    entries: SLACK_THREAD_ENTRIES,
    assistantName: "Vellum",
    referencedEntryId: null,
  },
  argTypes: {
    onToggleReference: { control: false },
    onClose: { control: false },
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <Story />
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ChannelTranscriptPanelView>;

/**
 * A Slack thread with everything Slack reports: named thread, senders,
 * timestamps, per-message links, an assistant reply, and a reaction event.
 * "Reference in Vellum" on a message row stages it (one slot: a second pick
 * replaces, the same pick clears), mirroring the store's toggle semantics.
 * The reaction row is activity rather than content and offers no reference
 * control.
 */
export const Default: Story = {
  render: function Render(args) {
    const [{ referencedEntryId }, updateArgs] = useArgs<{
      referencedEntryId: string | null;
    }>();
    return (
      <ChannelTranscriptPanelView
        {...args}
        referencedEntryId={referencedEntryId}
        onToggleReference={(entry) =>
          updateArgs({
            referencedEntryId:
              referencedEntryId === entry.id ? null : entry.id,
          })
        }
      />
    );
  },
};

/** A row already staged on the composer, drawn as pressed. */
export const ReferencedRow: Story = {
  ...Default,
  args: { referencedEntryId: "slack-2" },
};

/**
 * Rows whose optional provenance fields are absent (an unknown sender, a
 * missing timestamp) and a long pasted body rendered in full. Slack can
 * genuinely produce each of these, so this is degradation and wrapping, not
 * an error state.
 */
export const SparseRows: Story = {
  ...Default,
  args: { entries: SLACK_SPARSE_ENTRIES },
};

/** A bound Slack conversation whose thread has no attributable rows. */
export const EmptyThread: Story = {
  ...Default,
  args: { entries: [] },
};

/**
 * A channel with no per-row envelope on the wire (Discord here; email and
 * every other envelope-less channel read the same). The drawer still has the
 * thread's identity and the way back to the source, and the empty state says
 * why there is nothing to list, which is the generic fallback that keeps the
 * sidecar from being Slack-shaped.
 */
export const NoMessageDetailFallback: Story = {
  ...Default,
  args: {
    sidecarRef: {
      conversationId: DISCORD_TARGET.conversationId,
      channelId: DISCORD_TARGET.channelId,
    },
    threadName: DISCORD_TARGET.threadName,
    sourceHref: DISCORD_TARGET.sourceHref,
    entries: [],
  },
};
