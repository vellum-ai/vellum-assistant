/**
 * Pure mapping from daemon subagent-detail response events to the
 * SubagentTimelineEvent shape used by the subagent store.
 *
 * Coalesces consecutive text events and filters empty text bodies
 * so the timeline stays compact and readable.
 */

import type { SubagentDetailEvent } from "@vellumai/assistant-api";

import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

export function mapDetailEvents(
  raw: readonly SubagentDetailEvent[],
): SubagentTimelineEvent[] {
  let counter = 0;
  const events: SubagentTimelineEvent[] = [];

  for (const evt of raw) {
    let type: SubagentTimelineEvent["type"];
    switch (evt.type) {
      case "text":
      case "assistant_text_delta":
        type = "text";
        break;
      case "tool_use":
      case "tool_use_start":
        type = "tool_call";
        break;
      case "tool_result":
        type = "tool_result";
        break;
      case "error":
        type = "error";
        break;
      default:
        continue;
    }

    const content = evt.content;
    if (type === "text" && content === "") continue;

    // Coalesce consecutive text events into a single entry.
    const prev = events[events.length - 1];
    if (type === "text" && prev && prev.type === "text") {
      prev.content += "\n\n" + content;
      continue;
    }

    events.push({
      id: `detail-${++counter}`,
      type,
      content,
      toolName: evt.toolName,
      isError: evt.isError,
      // Carry the tool id + raw input through so history/reloaded subagents'
      // tool pills are clickable and the nested detail shows real input.
      // `result` rides in `content`, which `buildSubagentStepDetails` already
      // falls back to.
      toolUseId: evt.toolUseId,
      input: evt.input,
      timestamp: Date.now(),
    });
  }

  return events;
}
