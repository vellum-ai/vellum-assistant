/**
 * Synthetic-load fixtures for the subagent timeline.
 *
 * `makeSyntheticEvents(count)` produces a realistic, *deterministic* mix of
 * timeline events for perf/load testing. There is intentionally NO
 * `Math.random()` — every bit of variety is derived from the event index so
 * runs are reproducible and diffable.
 *
 * Event mix (by index, repeating every 20 events):
 *   ~40% tool_call   — long file-path / URL `content` + a `toolName`
 *   ~40% tool_result — multi-line `content` (> MAX_COLLAPSED_LINES=4 lines so
 *                      the timeline's "Show more" path is exercised); every
 *                      3rd one is `isError: true`
 *   ~15% text        — short response text
 *    ~5% error       — an error line
 *
 * Ids mirror the store's `generateTimelineEventId` (`te-${n}`, 1-based), and
 * timestamps are monotonic. Shared by `subagent-timeline.test.tsx` and
 * `subagent-timeline.perf.test.tsx`.
 */

import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

/** Sample tool names cycled through for `tool_call` events. */
const TOOL_NAMES = [
  "Read",
  "Edit",
  "Bash",
  "Grep",
  "Write",
  "WebFetch",
] as const;

/**
 * Long, unbreakable-ish content (file paths / URLs) for `tool_call` events —
 * the kind of content the timeline must wrap rather than clip.
 */
const LONG_PATHS = [
  "/workspaces/worktrees/p3-fixup-fork/clients/web/src/domains/channel/handler-inbound-admission.test.ts",
  "https://example.com/api/v2/organizations/acme-corp/workspaces/default/agents/subagent-timeline/runs?cursor=eyJpZCI6MTIzNDV9",
  "/Users/runner/work/vellum-assistant/vellum-assistant/clients/web/src/domains/chat/components/subagent-timeline.tsx",
  "packages/service-contracts/src/schemas/ces/streaming/subagent-inner-event.schema.ts",
] as const;

/**
 * Classify an event index into one of the four event types, distributing the
 * target mix deterministically across each block of 20 events.
 *
 * Slots 0–7   -> tool_call   (8/20 = 40%)
 * Slots 8–15  -> tool_result (8/20 = 40%)
 * Slots 16–18 -> text        (3/20 = 15%)
 * Slot  19    -> error       (1/20 = 5%)
 */
function typeForIndex(index: number): SubagentTimelineEvent["type"] {
  const slot = index % 20;
  if (slot < 8) return "tool_call";
  if (slot < 16) return "tool_result";
  if (slot < 19) return "text";
  return "error";
}

/** Build a multi-line tool_result body with > 4 lines (trips MAX_COLLAPSED_LINES). */
function multiLineResult(index: number): string {
  const lineCount = 5 + (index % 4); // 5..8 lines, always > 4
  const lines: string[] = [];
  for (let line = 0; line < lineCount; line++) {
    lines.push(`line ${line + 1} of tool result #${index} :: token-${index}-${line}`);
  }
  return lines.join("\n");
}

/** Build a single synthetic event for a 0-based index. */
function makeEvent(index: number): SubagentTimelineEvent {
  const type = typeForIndex(index);
  const id = `te-${index + 1}`;
  const timestamp = index; // monotonic

  switch (type) {
    case "tool_call":
      return {
        id,
        type,
        content: LONG_PATHS[index % LONG_PATHS.length],
        toolName: TOOL_NAMES[index % TOOL_NAMES.length],
        timestamp,
      };
    case "tool_result":
      return {
        id,
        type,
        content: multiLineResult(index),
        // Every 3rd tool_result is an error.
        isError: index % 3 === 0,
        toolName: TOOL_NAMES[index % TOOL_NAMES.length],
        toolUseId: `tu-${index + 1}`,
        timestamp,
      };
    case "text":
      return {
        id,
        type,
        content: `Synthetic response text for event #${index}.`,
        timestamp,
      };
    case "error":
      return {
        id,
        type,
        content: `Synthetic error #${index}: something went wrong in step ${index}.`,
        timestamp,
      };
  }
}

/**
 * Produce `count` deterministic synthetic timeline events.
 *
 * @param count Number of events to generate (>= 0).
 */
export function makeSyntheticEvents(count: number): SubagentTimelineEvent[] {
  const events: SubagentTimelineEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push(makeEvent(index));
  }
  return events;
}
