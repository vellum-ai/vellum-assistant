import { useEffect, useMemo } from "react";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useConversationStore } from "@/stores/conversation-store";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Where the inline "Connect Claude Code" card renders, or `null` when no
 * prompt is up.
 *
 * `inline` places it under the tool call it is anchored to, which is where the
 * failure the user just watched happened. `docked` places it above the
 * composer instead.
 */
export type AcpConnectPlacement = "inline" | "docked" | null;

/**
 * Decide where the Connect card belongs.
 *
 * The card is anchored to the tool call that spawned the run, and a mid-run
 * token rejection can raise it long after that call scrolled into history: the
 * spawn succeeds, the user keeps talking, and only then does the run fail. Left
 * inline, the card renders under a turn that is no longer on screen, so a user
 * sitting at the composer sees nothing at all and cannot reach the flow. The
 * daemon meanwhile refuses the secure-prompt fallback while a card is raised,
 * so there is no second way in.
 *
 * A user message after the anchor is what marks it as history: until then the
 * anchor's turn is still the last thing in the thread and the card sits in
 * view, in the context that explains it.
 *
 * The prompt deliberately outlives a conversation switch (`resetAll` carries
 * it over), so a transcript that does not hold the anchor is ambiguous on its
 * own. `promptConversationId` settles it: any conversation but its own renders
 * nothing, a new chat with no id yet included, since docking there would offer
 * Connect against the assistant the user navigated to. The same conversation with the anchor out of the loaded
 * window docks, because history opens at the latest 50 messages and a long
 * background run's spawn call is often above that, and a user at the composer
 * has no other way to reach the flow while the daemon still redirects the
 * fallback at this card.
 *
 * A prompt with no recorded owner (the pre-spawn `tool_result` path, which has
 * no run entry to read one from) renders only inline. Finding the anchor in
 * this transcript is then the proof of ownership, and without that proof it
 * does not dock: an unowned prompt that docked would follow the user into
 * whatever chat they opened next.
 */
export function decideAcpConnectPlacement(
  messages: readonly DisplayMessage[],
  toolUseId: string | null,
  promptConversationId?: string | null,
  activeConversationId?: string | null,
): AcpConnectPlacement {
  if (!toolUseId) {
    return null;
  }
  // A missing active conversation is a mismatch, not an absence of opinion: a
  // new chat has no id yet, and passing on it put the carried card above that
  // chat's composer, wired to whichever assistant had become active.
  if (
    promptConversationId != null &&
    promptConversationId !== activeConversationId
  ) {
    return null;
  }
  const anchorIndex = messages.findLastIndex((message) =>
    message.toolCalls?.some((toolCall) => toolCall.id === toolUseId),
  );
  if (anchorIndex === -1) {
    return promptConversationId != null ? "docked" : null;
  }
  const supersededByNewTurn = messages
    .slice(anchorIndex + 1)
    .some((message) => message.role === "user");
  return supersededByNewTurn ? "docked" : "inline";
}

/** {@link decideAcpConnectPlacement} over the live prompt and transcript. */
export function useAcpConnectPlacement(): AcpConnectPlacement {
  const prompt = useInteractionStore.use.pendingAcpConnect();
  const toolUseId = prompt?.toolUseId ?? null;
  const promptConversationId = prompt?.conversationId ?? null;
  const activeConversationId = useConversationStore.use.activeConversationId();
  const flowActive = useInteractionStore.use.acpConnectFlowActive();
  const held = useInteractionStore.use.acpConnectPlacement();
  const messages = useTranscriptMessages();

  const computed = useMemo(
    () =>
      decideAcpConnectPlacement(
        messages,
        toolUseId,
        promptConversationId,
        activeConversationId,
      ),
    [messages, toolUseId, promptConversationId, activeConversationId],
  );

  // Recorded only while no flow is running, so what it holds through one is
  // the position the card was last rendered at. Written from an effect rather
  // than during render: this is a note about what was committed, and both the
  // transcript and the composer ask, so it must not depend on which of them
  // renders first.
  useEffect(() => {
    if (flowActive) {
      return;
    }
    useInteractionStore
      .getState()
      .setAcpConnectPlacement(
        toolUseId ? { toolUseId, placement: computed } : null,
      );
  }, [flowActive, toolUseId, computed]);

  // A flow in progress pins the card where it already is. The user sending
  // another message is what would otherwise move it, and they can do that
  // while a browser tab is away at the OAuth consent screen. Keyed by the
  // anchor, so a newer prompt is placed on its own merits.
  if (
    flowActive &&
    toolUseId &&
    held?.toolUseId === toolUseId &&
    held.placement !== null
  ) {
    return held.placement;
  }
  return computed;
}

/**
 * The tool call the Connect card renders under, or `null` when it belongs
 * above the composer instead (or nowhere).
 *
 * Read once by `Transcript` and threaded down to the rows, so a row does not
 * subscribe to the transcript to answer a question about one tool call.
 * Subscribing per row would defeat `TranscriptRow`'s memo boundary: the
 * transcript array is replaced on every streaming delta, so every row would
 * rerender and rescan on each one, quadratic in the loaded row count.
 */
export function useAcpConnectInlineToolUseId(): string | null {
  const toolUseId =
    useInteractionStore.use.pendingAcpConnect()?.toolUseId ?? null;
  const placement = useAcpConnectPlacement();
  return placement === "inline" ? toolUseId : null;
}
