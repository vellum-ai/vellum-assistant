// Pure per-assistant-turn activity projection. No React/DOM imports so it can
// be exercised with `bun test` like `build-items.ts`.
//
// Grouping / resolution / suppression logic lives in the shared leaf module
// `./message-content`, which both this projection and the rendered DOM
// (`transcript-message-body.tsx`) import — so the projected anchors and the
// rendered anchors stay byte-identical. Cross-checked by
// transcript-message-body.test.tsx.

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  combineCardStates,
  computeToolCallCardData,
} from "@/domains/chat/hooks/tool-call-card-utils";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import {
  groupMessageContent,
  isSubagentSpawnCall,
  isSuppressedUiTool,
  resolveThinkingContent,
  resolveToolCall,
} from "@/domains/chat/transcript/message-content";

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
    state: combineCardStates(steps.map((s) => s.state)),
    stepCount: steps.length,
  };
}
