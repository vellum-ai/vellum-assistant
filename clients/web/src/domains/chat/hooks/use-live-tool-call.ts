import { useMemo } from "react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Where a tool call lives: the transcript on screen, or the history of one of
 * its subagents. Together with the call's id this is the identity a detail
 * drawer opens, so the drawer reads the call rather than a copy of it.
 * `snapshot` is a detail with no live source, shown as its payload says.
 */
export type ToolCallSource =
  | { kind: "transcript" }
  | { kind: "subagent"; subagentId: string }
  | { kind: "snapshot" };

/** The on-screen transcript, the source of every main-chat tool call. */
export const TRANSCRIPT_TOOL_CALL_SOURCE: ToolCallSource = {
  kind: "transcript",
};

/** A detail read from its payload alone. */
export const SNAPSHOT_TOOL_CALL_SOURCE: ToolCallSource = { kind: "snapshot" };

const NO_MESSAGES: DisplayMessage[] = [];

/** The tool call with `toolCallId` in `messages`, or `null`. */
export function findToolCall(
  messages: readonly DisplayMessage[],
  toolCallId: string,
): ChatMessageToolCall | null {
  for (const m of messages) {
    const tc = m.toolCalls?.find((t) => t.id === toolCallId);
    if (tc) {
      return tc;
    }
  }
  return null;
}

/**
 * Tool call looked up by id from its source, so an OPEN tool-detail drawer
 * reflects streamed `tool_output_chunk` output, the risk classification and
 * the final `result` as events land, instead of freezing the snapshot
 * captured when the drawer was opened. The sibling of
 * {@link useLiveThinkingText}.
 *
 * A transcript call resolves against the rendered transcript (server history
 * plus the in-flight turn) rather than the live turn alone: the live-turn to
 * history handoff drops the committed row from the live turn the moment the
 * turn finishes, and the committed call lives on the history row. A subagent
 * call resolves against that subagent's folded history in the subagent store.
 *
 * Returns `null` when the call can't be found (e.g. its message paged out of
 * the loaded transcript, or a subagent history not yet seeded) so callers fall
 * back to the open-time snapshot.
 */
export function useLiveToolCall(
  source: ToolCallSource,
  toolCallId: string | null | undefined,
): ChatMessageToolCall | null {
  const transcriptMessages = useTranscriptMessages();
  const subagentId = source.kind === "subagent" ? source.subagentId : null;
  const subagentMessages = useSubagentStore(
    (s) =>
      (subagentId ? s.byId[subagentId]?.history?.messages : undefined) ??
      NO_MESSAGES,
  );
  const messages =
    source.kind === "subagent" ? subagentMessages : transcriptMessages;
  const live = source.kind !== "snapshot";
  return useMemo(
    () => (live && toolCallId ? findToolCall(messages, toolCallId) : null),
    [live, messages, toolCallId],
  );
}
