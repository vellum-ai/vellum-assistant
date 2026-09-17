/**
 * Which detail a subagent timeline pill opens.
 *
 * A subagent's pills come from its flattened timeline events, and the detail
 * behind a tool pill can come from two places: the canonical call in the
 * subagent's history, or the payload built from those same events. The
 * canonical call carries more (risk, streamed output, structured metadata), so
 * it is preferred. The event-built payload is the floor, so a pill that renders
 * always opens something, and it wins whenever it knows more about how the
 * call ended than the canonical copy does: the canonical copy still runs while
 * the events show it finished, or it is marked finished without the result the
 * events carry (a history seeded from a snapshot older than the timeline).
 *
 * The choice is made on every render from the live canonical call, so once the
 * canonical copy catches up the drawer reads it live again.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  SNAPSHOT_TOOL_CALL_SOURCE,
  type ToolCallSource,
} from "@/domains/chat/hooks/use-live-tool-call";
import { toolDetailPayloadFromToolCall } from "@/domains/chat/utils/tool-call-card-utils";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import type { ToolDetailPayload } from "@/stores/viewer-store";

export interface SubagentStepDetail {
  detail: ToolDetailPayload;
  /** Where the drawer reads the call live: the subagent, or nowhere. */
  source: ToolCallSource;
}

/**
 * How much a copy knows about how the call ended: still running, finished
 * without its result, or finished with its result.
 */
function outcomeKnown(running: boolean, result: string | undefined): number {
  if (running) {
    return 0;
  }
  return result === undefined ? 1 : 2;
}

export function resolveSubagentStepDetail(
  canonicalCall: ChatMessageToolCall | null,
  eventDetail: ToolDetailPayload | undefined,
  subagentSource: ToolCallSource,
): SubagentStepDetail | undefined {
  const eventKnown = eventDetail
    ? outcomeKnown(eventDetail.status === "running", eventDetail.result)
    : -1;
  if (
    canonicalCall &&
    outcomeKnown(isToolCallRunning(canonicalCall), canonicalCall.result) >=
      eventKnown
  ) {
    return {
      detail: toolDetailPayloadFromToolCall(canonicalCall),
      source: subagentSource,
    };
  }
  return eventDetail
    ? { detail: eventDetail, source: SNAPSHOT_TOOL_CALL_SOURCE }
    : undefined;
}
