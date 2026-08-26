/**
 * React seam over the sidecar derivation: the flag, the conversation on
 * screen, and the transcript, folded into the one answer both lanes need.
 *
 * Its callers cannot share a render: the header registration, the chat lane
 * (`ChatMainPanel`), and the drawer panel each call it with the same
 * `useTranscriptMessages()` array, so every memo keys on the same identity
 * and the partition runs once per transcript change per consumer rather than
 * once per token.
 *
 * ## Identity stability
 *
 * The derivation rebuilds its objects on every transcript change, but its
 * consumers key memos and effects on the results, so this hook hands back the
 * PREVIOUS identities whenever the values did not move:
 *
 * - `target` stays reference-stable across streamed tokens, so the header
 *   slot registration does not re-fire per token.
 * - `vellumMessages` stays reference-stable when an update touched only
 *   channel rows, so the chat lane's transcript items hold still. That is
 *   also what stops the underfilled-viewport pagination from chain-loading
 *   history pages the lane will not show: a fetched page of channel-only rows
 *   leaves the lane's identity unchanged, so the scroll machinery sees no
 *   items change and does not re-fire.
 * - `entries` reuses each unchanged row's object, so an open drawer only
 *   re-renders the rows an update actually touched.
 */

import { useEffect, useMemo, useRef } from "react";

import type {
  ChannelMessageProvenance,
  ProvenanceConversation,
} from "@/domains/chat/channel-sidecar/channel-message-provenance";
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

function isSameTargetValue(
  a: ChannelSidecarTarget | null,
  b: ChannelSidecarTarget | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.conversationId === b.conversationId &&
    a.channelId === b.channelId &&
    a.threadName === b.threadName &&
    a.sourceHref === b.sourceHref
  );
}

function isSameProvenanceValue(
  a: ChannelMessageProvenance,
  b: ChannelMessageProvenance,
): boolean {
  return (
    a.channelId === b.channelId &&
    a.kind === b.kind &&
    a.externalMessageId === b.externalMessageId &&
    a.externalThreadId === b.externalThreadId &&
    a.externalChatId === b.externalChatId &&
    a.externalChatName === b.externalChatName &&
    a.senderName === b.senderName &&
    a.sourceLink?.webUrl === b.sourceLink?.webUrl &&
    a.sourceLink?.appUrl === b.sourceLink?.appUrl &&
    a.threadSourceLink?.webUrl === b.threadSourceLink?.webUrl &&
    a.threadSourceLink?.appUrl === b.threadSourceLink?.appUrl &&
    a.reaction?.emoji === b.reaction?.emoji &&
    a.reaction?.op === b.reaction?.op &&
    a.reaction?.actorName === b.reaction?.actorName
  );
}

function isSameEntryValue(
  a: ChannelTranscriptEntry,
  b: ChannelTranscriptEntry,
): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.timestamp === b.timestamp &&
    a.role === b.role &&
    isSameProvenanceValue(a.provenance, b.provenance)
  );
}

/**
 * Reuse `prev`'s elements (and, when every element survives, `prev` itself)
 * for the members of `next` that are value-equal.
 */
function stabilizeArray<T>(
  prev: T[] | undefined,
  next: T[],
  isSame: (a: T, b: T) => boolean,
): T[] {
  if (!prev) {
    return next;
  }
  if (prev === next) {
    return next;
  }
  let allReused = prev.length === next.length;
  const merged = next.map((item, i) => {
    const previous = prev[i];
    if (previous !== undefined && (previous === item || isSame(previous, item))) {
      return previous;
    }
    allReused = false;
    return item;
  });
  return allReused ? prev : merged;
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
  const previousRef = useRef<ChannelSidecar | null>(null);

  const result = useMemo(() => {
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
    const derived: ChannelSidecar = {
      target: hasChannelSidecarContent(target, entries) ? target : null,
      entries,
      vellumMessages,
    };

    const previous = previousRef.current;
    if (!previous) {
      return derived;
    }
    return {
      target: isSameTargetValue(previous.target, derived.target)
        ? previous.target
        : derived.target,
      entries: stabilizeArray(
        previous.entries,
        derived.entries,
        isSameEntryValue,
      ),
      vellumMessages: stabilizeArray(
        previous.vellumMessages,
        derived.vellumMessages,
        (a, b) => a === b,
      ),
    };
  }, [flagEnabled, messages, conversation, conversationId, sourceHref]);

  // Committed after render so a re-derivation compares against the identities
  // consumers actually hold.
  useEffect(() => {
    previousRef.current = result;
  });

  return result;
}
