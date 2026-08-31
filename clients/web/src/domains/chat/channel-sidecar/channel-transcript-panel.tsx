/**
 * Read-only external-channel transcript, rendered in the shared chat drawer.
 *
 * The canonical home for rows the client can attribute to a bound channel: the
 * Vellum lane omits them (see `partitionChannelTranscript`), so this panel is
 * where they are drawn, once.
 *
 * This is the container half of the drawer: it owns every store and query
 * read and hands the derived thread to `ChannelTranscriptPanelView`, which
 * renders it from props alone (and is what Storybook mounts).
 *
 * **Self-sourcing, and deliberately so.** The hosts that mount it
 * (`ChatContentLayout` on desktop, `MobileChatOverlays` on narrow viewports)
 * hold no transcript, and threading one through them would subscribe the whole
 * chat layout to every streaming token. Instead the panel reads the transcript
 * itself and re-derives its rows, which is also what keeps them live while the
 * drawer is open.
 *
 * **Nothing stale can reach the screen.** The viewer store holds only the
 * thread's identity; rows are matched against the conversation actually on
 * screen, so a conversation switch or a lost binding renders the empty state
 * for the frame before `reconcileChannelTranscript` settles the drawer, never
 * a previous thread's messages.
 */

import { useCallback } from "react";

import { toChannelReference } from "@/domains/chat/channel-sidecar/channel-reference";
import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import type { ChannelTranscriptEntry } from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import { ChannelTranscriptPanelView } from "@/domains/chat/channel-sidecar/channel-transcript-panel-view";
import { useChannelSidecar } from "@/domains/chat/channel-sidecar/use-channel-sidecar";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  isSameChannelSidecarRef,
  type ChannelSidecarRef,
} from "@/stores/viewer-store";
import { getChannelLabel } from "@/utils/channel-presentation";

interface ChannelTranscriptPanelProps {
  /** Thread the drawer was opened on, from the viewer store. */
  sidecarRef: ChannelSidecarRef;
  onClose: () => void;
}

export function ChannelTranscriptPanel({
  sidecarRef,
  onClose,
}: ChannelTranscriptPanelProps) {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const activeConversation = useActiveConversation(
    assistantId,
    activeConversationId,
    true,
  );
  const messages = useTranscriptMessages();
  const { target, entries } = useChannelSidecar({
    conversationId: activeConversationId,
    conversation: activeConversation,
    messages,
  });

  const assistantName = useAssistantIdentityStore.use.name();
  const stagedReference = useChannelReferenceStore.use.reference();
  const toggleReference = useChannelReferenceStore.use.toggleReference();

  // Only pass down rows belonging to the thread the drawer was opened on. A
  // conversation switch changes `activeConversationId` before the host
  // unmounts the panel, and this is what stops the new conversation's rows
  // from appearing under the old thread's heading.
  const isCurrentThread = isSameChannelSidecarRef(target, sidecarRef);
  const visibleEntries = isCurrentThread ? entries : [];
  const channelLabel = getChannelLabel(sidecarRef.channelId);

  const handleToggleReference = useCallback(
    (entry: ChannelTranscriptEntry) => {
      if (!target) {
        return;
      }
      toggleReference(toChannelReference({ entry, target, channelLabel }));
    },
    [target, toggleReference, channelLabel],
  );

  return (
    <ChannelTranscriptPanelView
      sidecarRef={sidecarRef}
      // Same guard as the rows: the heading names the thread only while the
      // thread it names is the one on screen, so a switch degrades to the bare
      // channel name rather than borrowing the next conversation's title.
      threadName={isCurrentThread ? target?.threadName : undefined}
      sourceHref={isCurrentThread ? target?.sourceHref : undefined}
      entries={visibleEntries}
      assistantName={assistantName}
      referencedEntryId={stagedReference?.messageId ?? null}
      onToggleReference={handleToggleReference}
      onClose={onClose}
    />
  );
}
