/**
 * React seam over the sidecar derivation: the flag, the conversation on
 * screen, and the transcript, folded into the one answer both lanes need.
 *
 * Its callers cannot share a render: the header registration, the chat lane
 * (`ChatMainPanel`), and the drawer panel each call it with the same
 * `useTranscriptMessages()` array, so every memo keys on the same identity
 * and the partition runs once per transcript change per consumer rather than
 * once per token.
 */

import { useMemo } from "react";

import type { ProvenanceConversation } from "@/domains/chat/channel-sidecar/channel-message-provenance";
import {
  hasChannelSidecarContent,
  partitionChannelTranscript,
  resolveChannelSidecarTarget,
  type ChannelSidecarTarget,
  type ChannelTranscriptEntry,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

export interface ChannelSidecar {
  /**
   * The thread to offer, or `null` when there is nothing worth opening (flag
   * off, ordinary Vellum conversation, or a binding with neither rows nor a
   * link). The header renders its channel-thread control on non-null and
   * falls back to the source-link pill otherwise.
   */
  target: ChannelSidecarTarget | null;
  /**
   * The external-channel lane, oldest first. Empty with the flag off, on an
   * ordinary Vellum conversation, or on a channel whose rows the client
   * cannot attribute.
   */
  entries: ChannelTranscriptEntry[];
  /**
   * The Vellum lane. Returned by reference from `messages` whenever nothing
   * moved, so conversations the sidecar does not touch see no new array.
   *
   * The partition applies whenever the flag is on and the conversation is
   * bound, whether or not the drawer is open: the drawer is the canonical home
   * for attributable rows, so they do not also sit in the lane waiting for
   * someone to open it.
   */
  vellumMessages: DisplayMessage[];
}

/**
 * Whether the sidecar flag is on for this client. The one place the flag's
 * store key is read: the derivation below gates on it, and `ChatMainPanel`
 * reconciles the staged-reference slot with it so a flag turned off leaves no
 * composer state behind.
 */
export function useChannelSidecarFlag(): boolean {
  return useClientFeatureFlagStore.use.channelConversationSidecar();
}

export function useChannelSidecar({
  conversationId,
  conversation,
  messages,
  sourceHref,
}: {
  conversationId: string | null | undefined;
  conversation: ProvenanceConversation | null | undefined;
  messages: DisplayMessage[];
  /**
   * Richer source link when the caller has one. The header derives a link
   * that folds in message-level links and covers daemons that do not populate
   * the binding's neutral `sourceLink`; the lane has no use for a link and
   * omits it, which only affects whether a linkless, rowless binding offers
   * the control.
   */
  sourceHref?: string | null;
}): ChannelSidecar {
  const flagEnabled = useChannelSidecarFlag();

  return useMemo(() => {
    if (!flagEnabled) {
      return { target: null, entries: [], vellumMessages: messages };
    }
    const { vellumMessages, entries } = partitionChannelTranscript({
      messages,
      conversation,
    });
    const target = resolveChannelSidecarTarget({
      conversationId,
      conversation,
      entries,
      sourceHref,
    });
    return {
      target: hasChannelSidecarContent(target, entries) ? target : null,
      entries,
      vellumMessages,
    };
  }, [flagEnabled, messages, conversation, conversationId, sourceHref]);
}
