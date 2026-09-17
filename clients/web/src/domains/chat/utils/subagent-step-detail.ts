/**
 * Which detail a subagent timeline pill opens.
 *
 * A subagent's pills come from its flattened timeline events, and the detail
 * behind a tool pill can come from two places: the canonical call in the
 * subagent's history, or the payload built from those same events. The
 * canonical call carries more (risk, streamed output, structured metadata), so
 * it is preferred. The event-built payload is the floor, so a pill that renders
 * always opens something, and it wins when it knows the call finished while
 * the canonical copy still reads as running (a history seeded from a snapshot
 * older than the result the timeline already has).
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

export function resolveSubagentStepDetail(
  canonicalCall: ChatMessageToolCall | null,
  eventDetail: ToolDetailPayload | undefined,
  subagentSource: ToolCallSource,
): SubagentStepDetail | undefined {
  const eventSettled =
    eventDetail !== undefined && eventDetail.status !== "running";
  if (canonicalCall && !(eventSettled && isToolCallRunning(canonicalCall))) {
    return {
      detail: toolDetailPayloadFromToolCall(canonicalCall),
      source: subagentSource,
    };
  }
  return eventDetail
    ? { detail: eventDetail, source: SNAPSHOT_TOOL_CALL_SOURCE }
    : undefined;
}
