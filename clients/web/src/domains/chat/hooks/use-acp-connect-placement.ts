import { useMemo } from "react";

import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
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
 * view, in the context that explains it. An anchor that has paged out of the
 * loaded transcript entirely docks for the same reason.
 */
export function decideAcpConnectPlacement(
  messages: readonly DisplayMessage[],
  toolUseId: string | null,
): AcpConnectPlacement {
  if (!toolUseId) {
    return null;
  }
  const anchorIndex = messages.findLastIndex((message) =>
    message.toolCalls?.some((toolCall) => toolCall.id === toolUseId),
  );
  if (anchorIndex === -1) {
    return "docked";
  }
  const supersededByNewTurn = messages
    .slice(anchorIndex + 1)
    .some((message) => message.role === "user");
  return supersededByNewTurn ? "docked" : "inline";
}

/** {@link decideAcpConnectPlacement} over the live prompt and transcript. */
export function useAcpConnectPlacement(): AcpConnectPlacement {
  const toolUseId =
    useInteractionStore.use.pendingAcpConnect()?.toolUseId ?? null;
  const messages = useTranscriptMessages();

  return useMemo(
    () => decideAcpConnectPlacement(messages, toolUseId),
    [messages, toolUseId],
  );
}
