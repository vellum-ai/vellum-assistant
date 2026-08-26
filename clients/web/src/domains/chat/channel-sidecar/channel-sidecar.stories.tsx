/**
 * The channel sidecar as the product ships it, end to end: the header's
 * channel-thread control, the read-only transcript drawer beside the chat
 * column, and "Reference in Vellum" staging the removable reference chip
 * above the real composer.
 *
 * Every piece is the shipped component. The control and the chip self-source
 * from the real viewer and channel-reference stores, and the drawer rows
 * stage through the same `toChannelReference` + `toggleReference` calls the
 * production container makes, so the round trip a reviewer clicks through
 * here is the app's: toggle the drawer from the header, pick a row, watch the
 * chip appear over the composer, clear it from either end.
 *
 * These stories drive the shipped Zustand stores rather than args, because
 * that shared single-slot state IS the interaction under review and args
 * cannot reach components that self-source from a store. The arg-driven
 * coverage of each surface lives in its own story file
 * (`Chat/ChannelThreadControl`, `Chat/ChannelTranscriptPanel`,
 * `Chat/ChannelTranscriptEntryRow`).
 *
 * The chat column carries no transcript: the sidecar's Vellum lane is the
 * ordinary chat, which is not the subject here, and the drawer needs the
 * column only as the flex sibling it takes its width from. The composer stack
 * is mounted for real because the chip's whole job is to sit on it.
 */

import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { toChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import { ChannelReferenceChip } from "@/domains/chat/channel-sidecar/channel-reference-chip";
import {
  DISCORD_TARGET,
  SLACK_TARGET,
  SLACK_THREAD_ENTRIES,
} from "@/domains/chat/channel-sidecar/channel-sidecar-story-fixtures";
import type {
  ChannelSidecarTarget,
  ChannelTranscriptEntry,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import { ChannelThreadControl } from "@/domains/chat/channel-sidecar/channel-thread-control";
import { ChannelTranscriptPanelView } from "@/domains/chat/channel-sidecar/channel-transcript-panel-view";
import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";
import { ChatColumn } from "@/domains/chat/components/chat-column";
import { StagedQuotesStrip } from "@/domains/chat/components/staged-quotes-strip";
import { StoryComposer } from "@/domains/chat/components/story-composer";
import { isSameChannelSidecarRef, useViewerStore } from "@/stores/viewer-store";
import { getChannelLabel } from "@/utils/channel-presentation";

function ChannelSidecarSlice({
  target,
  entries,
}: {
  target: ChannelSidecarTarget;
  entries: ChannelTranscriptEntry[];
}) {
  const mainView = useViewerStore.use.mainView();
  const activeChannelTranscript =
    useViewerStore.use.activeChannelTranscript();
  const stagedReference = useChannelReferenceStore.use.reference();
  const channelLabel = getChannelLabel(target.channelId);

  // Start with the drawer open so the whole slice is on screen at first
  // paint; the header control keeps working as the live toggle. Both stores
  // are shared across stories, so unmount settles them back to resting.
  useEffect(() => {
    useViewerStore.getState().openChannelTranscript({
      conversationId: target.conversationId,
      channelId: target.channelId,
    });
    return () => {
      useViewerStore.getState().reconcileChannelTranscript(null);
      useChannelReferenceStore.getState().clearReference();
    };
  }, [target.conversationId, target.channelId]);

  const open =
    mainView === "channel-transcript" &&
    isSameChannelSidecarRef(activeChannelTranscript, target);

  return (
    <div className="flex h-screen flex-col bg-[var(--surface-base)]">
      {/* The top bar's right cluster, where `useChatHeaderRegistration` puts
          the control. The rest of the header is not the subject and would
          drag in cross-domain pieces, so only the cluster's corner is here. */}
      <div className="flex h-12 shrink-0 items-center justify-end gap-2 px-3">
        <ChannelThreadControl target={target} />
      </div>
      <div className="min-h-0 flex-1">
        <AnimatedRightDrawer
          open={open}
          left={
            <div className="flex h-full flex-col justify-end">
              {/* The composer stack in `chat-body` order: chip, quote strip,
                  composer, sharing the real column width and gutters. */}
              <ChatColumn className="pt-1 pb-2 sm:pb-0">
                <ChannelReferenceChip />
                <StagedQuotesStrip />
                <StoryComposer placeholder="What would you like to do?" />
              </ChatColumn>
            </div>
          }
          right={
            <ChannelTranscriptPanelView
              sidecarRef={{
                conversationId: target.conversationId,
                channelId: target.channelId,
              }}
              threadName={target.threadName}
              sourceHref={target.sourceHref}
              entries={entries}
              assistantName="Vellum"
              referencedEntryId={stagedReference?.messageId ?? null}
              onToggleReference={(entry) =>
                useChannelReferenceStore
                  .getState()
                  .toggleReference(
                    toChannelReference({ entry, target, channelLabel }),
                  )
              }
              onClose={() =>
                useViewerStore.getState().closeChannelTranscript()
              }
            />
          }
        />
      </div>
    </div>
  );
}

const meta: Meta = {
  title: "Chat/ChannelSidecar",
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

export default meta;

type Story = StoryObj;

/**
 * A Slack-bound conversation with everything Slack reports. Pick "Reference
 * in Vellum" on a message row: the chip animates in above the composer, the
 * row draws as pressed, a second row replaces the first (one slot), and the
 * chip's X or the pressed row clears it. The reaction row offers no reference
 * control. The header control and the panel's X both close the drawer.
 */
export const SlackThread: Story = {
  render: () => (
    <ChannelSidecarSlice
      target={SLACK_TARGET}
      entries={SLACK_THREAD_ENTRIES}
    />
  ),
};

/**
 * A channel with no per-row envelope on the wire (Discord here). The same
 * control and drawer render its identity, its way back to the source, and the
 * empty-detail explanation instead of rows: the generic fallback, with no
 * per-channel eligibility gate in front of it.
 */
export const DiscordWithoutMessageDetail: Story = {
  render: () => <ChannelSidecarSlice target={DISCORD_TARGET} entries={[]} />,
};
