/**
 * Classify subagent events as evidence that a child run is still moving.
 *
 * A synchronous caller bounds its wait with an idle window, and the only thing
 * that resets that window is a progress signal. Streamed tokens are the obvious
 * one, but a subagent that calls a tool goes silent for the whole execution
 * while producing no delta, so tool activity counts as well: the call being
 * recognized, its input streaming in, its output streaming out, and its result
 * landing. Without it, a healthy child reading a large file looks identical to
 * a stalled one and is aborted before the model ever sees its tool result.
 *
 * Its own module so the classification can be unit-tested (and imported by a
 * deadline test) without pulling in the manager and its Conversation graph.
 */

import type { AssistantEvent } from "../api/index.js";

const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant_text_delta",
  "assistant_thinking_delta",
  "tool_use_preview_start",
  "tool_use_start",
  "tool_input_delta",
  "tool_output_chunk",
  "tool_result",
]);

/**
 * Whether an event is evidence of forward progress in a child run. Pure, and
 * deliberately an allowlist: a lifecycle or status event says nothing about
 * whether work is happening, so an unknown event type never extends a deadline.
 */
export function isSubagentProgressEvent(msg: AssistantEvent): boolean {
  return PROGRESS_EVENT_TYPES.has(msg.type);
}
