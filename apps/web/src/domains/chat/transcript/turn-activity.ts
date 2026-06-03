// Pure per-assistant-turn activity projection. No React/DOM imports so it can
// be exercised with `bun test` like `build-items.ts`.
//
// Grouping rules MIRROR transcript-message-body.tsx; keep in lockstep —
// cross-checked by transcript-message-body.test.tsx in PR 3.

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { computeToolCallCardData } from "@/domains/chat/hooks/tool-call-card-utils";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

export type ActivityKind = "thinking" | "tool";

/**
 * Single source of truth for activity anchor ids — used here AND by the
 * rendered DOM in PR 3, so the render anchors and the projected anchors stay
 * byte-identical.
 */
export function activityAnchorId(
  messageId: string,
  kind: ActivityKind,
  firstId: string,
): string {
  return `activity-${messageId}-${kind === "thinking" ? "th" : "tc"}-${firstId}`;
}

export interface ActivityStep {
  anchorId: string;
  kind: ActivityKind;
  title: string;
  info: string;
  state: "loading" | "complete" | "error" | "denied";
  iconName?: string;
  riskLevel?: string;
}

export interface TurnActivity {
  steps: ActivityStep[];
  currentStepTitle: string;
  currentStepInfo: string;
  state: "loading" | "complete" | "error" | "denied";
  stepCount: number;
}

/**
 * Grouped content shape — a pure replica of the `ContentGroup` union in the
 * interleaved branch of `transcript-message-body.tsx`.
 */
export type ContentGroup =
  | { type: "text"; id: string }
  | { type: "toolCalls"; ids: string[] }
  | { type: "thinking"; ids: string[] }
  | { type: "surface"; id: string };

/**
 * Group consecutive `message.contentOrder` entries — merge adjacent
 * `toolCall`/`tool` entries into one group, merge adjacent `thinking` entries
 * into one group, and pass `text`/`surface` through individually. Mirrors the
 * interleaved-branch loop in `transcript-message-body.tsx`.
 */
export function groupMessageContent(message: DisplayMessage): ContentGroup[] {
  const groups: ContentGroup[] = [];
  for (const entry of message.contentOrder ?? []) {
    if (entry.type === "toolCall" || entry.type === "tool") {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.type === "toolCalls") {
        lastGroup.ids.push(entry.id);
      } else {
        groups.push({ type: "toolCalls", ids: [entry.id] });
      }
    } else if (entry.type === "thinking") {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup?.type === "thinking") {
        lastGroup.ids.push(entry.id);
      } else {
        groups.push({ type: "thinking", ids: [entry.id] });
      }
    } else if (entry.type === "text") {
      groups.push({ type: "text", id: entry.id });
    } else if (entry.type === "surface") {
      groups.push({ type: "surface", id: entry.id });
    }
  }
  return groups;
}

/**
 * Resolve a tool call from a contentOrder id — find by `id`, else parse-int the
 * id into a positional index of `message.toolCalls`. Mirrors `resolveToolCall`
 * in `transcript-message-body.tsx`.
 */
function resolveToolCall(
  message: DisplayMessage,
  id: string,
): ChatMessageToolCall | undefined {
  const tc = message.toolCalls?.find((t) => t.id === id);
  if (tc) {
    return tc;
  }
  const idx = parseInt(id, 10);
  if (!isNaN(idx) && message.toolCalls && idx < message.toolCalls.length) {
    return message.toolCalls[idx];
  }
  return undefined;
}

/**
 * Join the reasoning segments referenced by a run of `thinking` contentOrder
 * ids into one string. Mirrors `resolveThinkingContent` in
 * `transcript-message-body.tsx`.
 */
function resolveThinkingContent(message: DisplayMessage, ids: string[]): string {
  return ids
    .map((id) => {
      const idx = parseInt(id, 10);
      return !isNaN(idx) ? message.thinkingSegments?.[idx] : undefined;
    })
    .filter((s): s is string => Boolean(s))
    .join("\n");
}

/**
 * Detect a `subagent_spawn` invocation in either canonical form. Mirrors
 * `isSubagentSpawnCall` in `transcript-message-body.tsx`.
 */
function isSubagentSpawnCall(toolCall: ChatMessageToolCall): boolean {
  if (toolCall.toolName === "subagent_spawn") return true;
  if (toolCall.toolName !== "skill_execute") return false;
  const input = toolCall.input;
  if (input == null || typeof input !== "object") return false;
  return (input as Record<string, unknown>).tool === "subagent_spawn";
}

/**
 * UI surface tools are rendered by the inline surface widget, not as tool-call
 * chips — unless they carry a pending confirmation. Mirrors `isSuppressedUiTool`
 * in `transcript-message-body.tsx`.
 */
function isSuppressedUiTool(tc: ChatMessageToolCall): boolean {
  return (
    !tc.pendingConfirmation &&
    (tc.toolName === "ui_show" ||
      tc.toolName === "ui_update" ||
      tc.toolName === "ui_dismiss")
  );
}

/**
 * Aggregate card-level state across steps using the same precedence as
 * `deriveCardState` in tool-call-card-utils.ts: denied > loading > error >
 * complete.
 */
function aggregateState(
  states: Array<"loading" | "complete" | "error" | "denied">,
): "loading" | "complete" | "error" | "denied" {
  if (states.includes("denied")) return "denied";
  if (states.includes("loading")) return "loading";
  if (states.includes("error")) return "error";
  return "complete";
}

/** Icon name of the last `tool`-kind step in a `ToolCallCardData.steps`. */
function lastToolIconName(
  steps: ReturnType<typeof computeToolCallCardData>["steps"],
): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.kind === "tool") return step.iconName;
  }
  return undefined;
}

/** Build a single `tool` step from a group's renderable tool calls. */
function buildToolActivityStep(
  message: DisplayMessage,
  calls: ChatMessageToolCall[],
): ActivityStep | null {
  const renderable = calls.filter(
    (tc) => !isSuppressedUiTool(tc) && !isSubagentSpawnCall(tc),
  );
  if (renderable.length === 0) return null;
  const first = renderable[0]!;
  const d = computeToolCallCardData(renderable, {}, null);
  return {
    kind: "tool",
    anchorId: activityAnchorId(message.id, "tool", first.id),
    title: d.currentStepTitle,
    info: d.currentStepInfo,
    state: d.state,
    iconName: lastToolIconName(d.steps),
    riskLevel: first.riskLevel,
  };
}

const EMPTY_TURN_ACTIVITY: TurnActivity = {
  steps: [],
  currentStepTitle: "",
  currentStepInfo: "",
  state: "complete",
  stepCount: 0,
};

/**
 * Project an assistant `DisplayMessage` into the per-turn activity model that
 * drives the combined progress card. Covers both render shapes:
 *
 *   - Interleaved: `contentOrder` carries `toolCall`/`tool` entries, walked via
 *     `groupMessageContent`.
 *   - Legacy: no interleaved tool calls — thinking runs from `contentOrder`
 *     plus a single trailing tool step from `message.toolCalls`.
 *
 * Returns an empty `TurnActivity` for non-assistant messages.
 */
export function buildTurnActivity(message: DisplayMessage): TurnActivity {
  if (message.role !== "assistant") {
    return EMPTY_TURN_ACTIVITY;
  }

  const steps: ActivityStep[] = [];

  const hasInterleavedToolCalls = message.contentOrder?.some(
    (e) => e.type === "toolCall" || e.type === "tool",
  );

  if (hasInterleavedToolCalls) {
    for (const group of groupMessageContent(message)) {
      if (group.type === "thinking") {
        const content = resolveThinkingContent(message, group.ids);
        if (!content) continue;
        steps.push({
          kind: "thinking",
          anchorId: activityAnchorId(message.id, "thinking", group.ids[0]!),
          title: "Thought process",
          info: "",
          state: "complete",
        });
      } else if (group.type === "toolCalls") {
        const calls = group.ids
          .map((id) => resolveToolCall(message, id))
          .filter((tc): tc is ChatMessageToolCall => tc != null);
        const step = buildToolActivityStep(message, calls);
        if (step) steps.push(step);
      }
    }
  } else {
    // Legacy shape: emit thinking steps by buffering consecutive `thinking`
    // ids, then one trailing tool step from `message.toolCalls`.
    let pendingThinkingIds: string[] = [];
    const flushThinking = () => {
      if (pendingThinkingIds.length === 0) return;
      const ids = pendingThinkingIds;
      pendingThinkingIds = [];
      const content = resolveThinkingContent(message, ids);
      if (!content) return;
      steps.push({
        kind: "thinking",
        anchorId: activityAnchorId(message.id, "thinking", ids[0]!),
        title: "Thought process",
        info: "",
        state: "complete",
      });
    };
    for (const entry of message.contentOrder ?? []) {
      if (entry.type === "thinking") {
        pendingThinkingIds.push(entry.id);
        continue;
      }
      flushThinking();
    }
    flushThinking();

    const step = buildToolActivityStep(message, message.toolCalls ?? []);
    if (step) steps.push(step);
  }

  const last = steps[steps.length - 1];
  return {
    steps,
    currentStepTitle: last?.title ?? "",
    currentStepInfo: last?.info ?? "",
    state: aggregateState(steps.map((s) => s.state)),
    stepCount: steps.length,
  };
}
