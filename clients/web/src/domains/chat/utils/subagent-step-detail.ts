/**
 * The detail a subagent timeline pill opens.
 *
 * A subagent's pills come from its flattened timeline events, and a tool pill's
 * detail exists in two copies: the canonical call in the subagent's history,
 * and the payload built from those same events. Either can know something the
 * other does not. The canonical call carries risk, streamed output and
 * structured metadata; the event-built copy can hold a result or parsed search
 * sources the history has not caught up to (a history seeded from a snapshot
 * older than the timeline, or a call force-completed without its result).
 *
 * So the two are merged rather than one chosen: the canonical call is the base,
 * every field it leaves empty is filled from the event-built copy (its input
 * before the labels are derived, so they describe the input shown), and the
 * status is the more final of the two. Nothing either copy knows is discarded,
 * and the merge is remade on every render from the live canonical call, so the
 * detail tracks the history as it fills in.
 */

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolDetailPayloadFromToolCall } from "@/domains/chat/utils/tool-call-card-utils";
import type { ToolDetailPayload } from "@/stores/viewer-store";

/**
 * How final a status is, in the precedence `toolCallRank` gives tool calls:
 * a refusal or an error outranks a completion, which outranks running.
 */
const STATUS_RANK: Record<ToolDetailPayload["status"], number> = {
  running: 0,
  completed: 1,
  error: 2,
  denied: 2,
};

function mergeDetails(
  canonical: ToolDetailPayload,
  event: ToolDetailPayload,
): ToolDetailPayload {
  return {
    ...canonical,
    kind: canonical.kind ?? event.kind,
    result: canonical.result ?? event.result,
    streamedOutput: canonical.streamedOutput ?? event.streamedOutput,
    durationLabel: canonical.durationLabel || event.durationLabel,
    searchQuery: canonical.searchQuery || event.searchQuery,
    searchResults: canonical.searchResults?.length
      ? canonical.searchResults
      : (event.searchResults ?? canonical.searchResults),
    status:
      STATUS_RANK[event.status] > STATUS_RANK[canonical.status]
        ? event.status
        : canonical.status,
  };
}

export function resolveSubagentStepDetail(
  canonicalCall: ChatMessageToolCall | null,
  eventDetail: ToolDetailPayload | undefined,
): ToolDetailPayload | undefined {
  if (!canonicalCall) {
    return eventDetail;
  }
  if (!eventDetail) {
    return toolDetailPayloadFromToolCall(canonicalCall);
  }
  // The input is filled on the call, before the payload is built, so the title
  // and activity derive from the input the detail shows: a canonical copy from
  // a streaming preview can still hold an empty input the events have filled.
  const call =
    Object.keys(canonicalCall.input).length > 0
      ? canonicalCall
      : { ...canonicalCall, input: eventDetail.input };
  return mergeDetails(toolDetailPayloadFromToolCall(call), eventDetail);
}
