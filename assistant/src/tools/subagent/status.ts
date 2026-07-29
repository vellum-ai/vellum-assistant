import { getSubagentRecordsByParent } from "../../persistence/subagent-store.js";
import {
  getSubagentManager,
  settleUnsupervisedStatus,
  subagentStateFromRecord,
  TERMINAL_STATUSES,
} from "../../subagent/index.js";
import {
  boundRecentTerminal,
  type SubagentState,
} from "../../subagent/types.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import {
  resolveSubagentId,
  resolveSubagentState,
  subagentRefInputSchema,
} from "./resolve.js";

export const subagentStatusInputSchema = subagentRefInputSchema;

/**
 * Cap on the finished subagents the list-all path reports, applied to the
 * durable query and to the merged result alike. Rows live as long as the parent
 * conversation, so an old chat holds every subagent it ever spawned and the
 * model wants the recent ones, not the whole history. Unsettled subagents are
 * never capped. Matches the reconcile route's bound.
 */
const MAX_LISTED_TERMINAL_RECORDS = 20;

/**
 * Every subagent of `parentConversationId`: the manager's live entries plus the
 * durable rows it no longer holds, because the TTL sweep evicted them or a
 * restart's rehydration bound left them out. Addressing one by id or label
 * already falls back to the row, so listing from memory alone would omit
 * subagents the very next call can answer for.
 *
 * Live state wins for an id both sides carry. A row-only entry maps through the
 * same pair the single-subagent fallback uses, so nothing is executing it and
 * an active recorded status reads as `interrupted`. The merged set is re-bounded
 * because the manager's own rehydration cap is far larger than this one.
 */
function listSubagentsForParent(parentConversationId: string): SubagentState[] {
  const byId = new Map<string, SubagentState>();
  const records = getSubagentRecordsByParent(parentConversationId, {
    terminalStatuses: [...TERMINAL_STATUSES],
    maxTerminal: MAX_LISTED_TERMINAL_RECORDS,
  });
  for (const record of records) {
    const state = subagentStateFromRecord(record);
    byId.set(record.id, {
      ...state,
      status: settleUnsupervisedStatus(state.status),
    });
  }
  for (const child of getSubagentManager().getChildrenOf(
    parentConversationId,
  )) {
    byId.set(child.config.id, child);
  }
  return boundRecentTerminal(
    [...byId.values()],
    MAX_LISTED_TERMINAL_RECORDS,
  ).sort(
    (a, b) =>
      a.createdAt - b.createdAt || a.config.id.localeCompare(b.config.id),
  );
}

export async function executeSubagentStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = subagentStatusInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("subagent_status", parsedInput.error);
  }
  const parsed = parsedInput.data;
  const subagentId = resolveSubagentId(parsed, context);

  // If a label was provided but didn't resolve, that's an error — don't fall
  // through to the "list all" path.
  if (!subagentId && parsed.label) {
    return {
      content: `No subagent found with label "${parsed.label}".`,
      isError: true,
    };
  }

  if (subagentId) {
    const state = resolveSubagentState(subagentId);
    if (
      !state ||
      state.config.parentConversationId !== context.conversationId
    ) {
      return {
        content: `No subagent found with ID "${subagentId}".`,
        isError: true,
      };
    }
    return {
      content: JSON.stringify({
        subagentId: state.config.id,
        label: state.config.label,
        status: state.status,
        isFork: state.isFork,
        error: state.error,
        createdAt: state.createdAt,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        usage: state.usage,
      }),
      isError: false,
    };
  }

  // List all subagents for this parent conversation.
  const children = listSubagentsForParent(context.conversationId);
  if (children.length === 0) {
    return {
      content: "No subagents found for this conversation.",
      isError: false,
    };
  }

  const summary = children.map((s) => ({
    subagentId: s.config.id,
    label: s.config.label,
    status: s.status,
    isFork: s.isFork,
    error: s.error,
  }));

  return { content: JSON.stringify(summary), isError: false };
}
