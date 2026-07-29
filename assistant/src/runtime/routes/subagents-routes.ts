/**
 * Route handlers for subagent operations.
 *
 * Exposes subagent detail, abort, and message operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/subagents.ts`.
 */
import { z } from "zod";

import {
  type SubagentStatus,
  SubagentStatusSchema,
  SubagentUsageStatsSchema,
} from "../../api/events/subagent-status-changed.js";
import { SubagentDetailResponseSchema } from "../../api/responses/subagent-detail.js";
import {
  getMessages,
  type MessageRow,
} from "../../persistence/conversation-crud.js";
import { getConversationUsageTotals } from "../../persistence/llm-usage-store.js";
import {
  getSubagentRecordById,
  getSubagentRecordsByParent,
  type SubagentRecord,
} from "../../persistence/subagent-store.js";
import { getSubagentManager } from "../../subagent/index.js";
import {
  boundRecentTerminal,
  settleUnsupervisedStatus,
  type SubagentState,
  TERMINAL_STATUSES,
} from "../../subagent/types.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("subagents-routes");

// ---------------------------------------------------------------------------
// Shared business logic (used by both message handlers and HTTP routes)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

export interface SubagentDetailResult {
  subagentId: string;
  objective?: string;
  usage?: { inputTokens: number; outputTokens: number; estimatedCost: number };
  events: Array<{
    type: string;
    content: string;
    toolName?: string;
    isError?: boolean;
    messageId?: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
  }>;
}

const FORK_DIRECTIVE_RE =
  /^⎯⎯⎯ FORK TASK ⎯⎯⎯\n[\s\S]*?Complete this task directly and return only your findings:\n\n([\s\S]*?)\n⎯⎯⎯+$/;

function stripForkDirectiveFraming(text: string): string {
  const match = FORK_DIRECTIVE_RE.exec(text);
  return match ? match[1] : text;
}

/**
 * Parse raw message rows into subagent detail events. Extracted as a pure
 * function so it can be unit-tested without a database.
 */
export function parseSubagentMessages(
  subagentId: string,
  messages: MessageRow[],
): SubagentDetailResult {
  // Extract objective from the first user message
  let objective: string | undefined;
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    try {
      const textBlock = firstUser.content.find(
        (b) => b.type === "text" && typeof b.text === "string",
      );
      if (textBlock && "text" in textBlock) {
        objective = stripForkDirectiveFraming(textBlock.text);
      }
    } catch {
      /* ignore */
    }
  }

  // Extract events from both assistant and user messages.
  const events: SubagentDetailResult["events"] = [];
  const pendingTools = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" && m.role !== "user") {
      continue;
    }
    const content: unknown[] = m.content;

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") {
        continue;
      }
      if (
        m.role === "assistant" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        events.push({ type: "text", content: block.text, messageId: m.id });
      } else if (
        block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "mcp_tool_use"
      ) {
        const name = typeof block.name === "string" ? block.name : "unknown";
        const input = isRecord(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
        const id = typeof block.id === "string" ? block.id : "";
        events.push({
          type: "tool_use",
          content: JSON.stringify(input),
          toolName: name,
          toolUseId: id || undefined,
          input,
        });
        if (id) {
          pendingTools.set(id, name);
        }
      } else if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result" ||
        block.type === "mcp_tool_result"
      ) {
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const resultContent =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as unknown[])
                  .filter((b): b is Record<string, unknown> => isRecord(b))
                  .map((b) => {
                    if (b.type === "text" && typeof b.text === "string") {
                      return b.text;
                    }
                    if (
                      b.type === "web_search_result" &&
                      typeof b.title === "string"
                    ) {
                      return `${b.title}\n${typeof b.url === "string" ? b.url : ""}`;
                    }
                    return null;
                  })
                  .filter((s): s is string => s != null)
                  .join("\n")
              : "";
        const isError = block.is_error === true;
        const toolName = toolUseId ? pendingTools.get(toolUseId) : undefined;
        events.push({
          type: "tool_result",
          content: resultContent,
          toolName: toolName ?? "unknown",
          isError,
          toolUseId: toolUseId || undefined,
        });
      }
    }
  }

  return { subagentId, objective, events };
}

/**
 * The usage worth putting on the wire, shared by the detail and reconcile
 * routes. A child that has spent nothing reports no usage at all, an all-zero
 * snapshot tells a client nothing its own tally doesn't already say. Cost with
 * no counted tokens is still spend, so all three fields must be empty before
 * the field is dropped.
 */
function reportableUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}): z.infer<typeof SubagentUsageStatsSchema> | undefined {
  if (
    usage.inputTokens <= 0 &&
    usage.outputTokens <= 0 &&
    usage.estimatedCost <= 0
  ) {
    return undefined;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost: usage.estimatedCost,
  };
}

function getSubagentDetail(
  subagentId: string,
  conversationId: string,
): SubagentDetailResult {
  const messages = getMessages(conversationId);
  log.debug(
    { subagentId, conversationId, messageCount: messages.length },
    "getSubagentDetail: raw messages from DB",
  );
  const result = parseSubagentMessages(subagentId, messages);
  log.debug(
    { subagentId, eventCount: result.events.length },
    "getSubagentDetail: parsed events",
  );
  const usage = reportableUsage(getConversationUsageTotals(conversationId));
  if (usage) {
    result.usage = usage;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** `status` is the only guaranteed key; every other field is optional. */
const ReconciledSubagentSchema = z.object({
  status: z.string(),
  conversationId: z.string().optional(),
  label: z.string().optional(),
  objective: z.string().optional(),
  isFork: z.boolean().optional(),
  parentToolUseId: z.string().optional(),
  /**
   * Terminal metadata a client can otherwise only learn from the
   * `subagent_status_changed` event, which is exactly the event a
   * reconciling client may have missed. Carried here so the snapshot can
   * restore final token/cost totals and a failure reason instead of leaving
   * them owned by a lost event.
   */
  usage: SubagentUsageStatsSchema.optional(),
  error: z.string().optional(),
});

/**
 * The status to report for a durable row, or `undefined` when the caller should
 * omit the field. `SubagentRecord.status` is an untyped column while both route
 * contracts are the closed `SubagentStatusSchema` enum, so a value that doesn't
 * parse is dropped rather than widening the wire type; anything that does parse
 * is settled by `settleUnsupervisedStatus`.
 *
 * The result is only ever OBSERVED for a row no live manager entry answers
 * for: the detail route reads the record solely when `getState` came back
 * empty, and the reconcile route calls this for every durable row but lets its
 * live pass overwrite the ids memory still holds.
 */
function settledRecordStatus(
  record: SubagentRecord,
): SubagentStatus | undefined {
  const parsed = SubagentStatusSchema.safeParse(record.status);
  return parsed.success ? settleUnsupervisedStatus(parsed.data) : undefined;
}

/**
 * Cap on the terminal subagents the reconcile snapshot carries per parent,
 * applied to the durable pass and the live pass alike. Rows live as long as the
 * conversation, so an old chat holds every subagent it ever spawned and a
 * restart rehydrates hundreds of them into memory; a client rebuilding its list
 * needs the recent ones, not the full history. Subagents that are not terminal
 * are never capped, a client's stuck-active entry has to be settled at any age.
 */
const MAX_RECONCILED_TERMINAL_RECORDS = 20;

function liveReconciledEntry(
  child: SubagentState,
): z.infer<typeof ReconciledSubagentSchema> {
  return {
    status: child.status,
    conversationId: child.conversationId,
    label: child.config.label,
    objective: child.config.objective,
    isFork: child.isFork,
    parentToolUseId: child.config.parentToolUseId,
    usage: child.usage ? reportableUsage(child.usage) : undefined,
    error: child.error,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "reconcileSubagents",
    endpoint: "subagents/reconcile",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Reconcile subagent live status",
    description:
      "Returns the subagents the assistant knows for a given parent conversation (live, rehydrated, and durably recorded), including recently finished runs whose in-memory metadata the retention sweep has already evicted. Durable records live as long as the conversation, so the snapshot is bounded: every subagent not in a terminal state is always returned, plus the 20 most recently finished ones. Each entry carries enough detail (child conversation id, label, objective, token usage, failure reason) for a client to rebuild its subagent list from scratch, not just refresh statuses. A subagent absent from the response is one the assistant no longer reports, so a client may settle its own stuck-active entries against this snapshot. Only `status` is guaranteed to be present; every other field is optional.",
    tags: ["subagents"],
    queryParams: [
      {
        name: "parentConversationId",
        schema: { type: "string" },
        description: "Parent conversation ID",
      },
    ],
    responseBody: z.object({
      subagents: z.record(z.string(), ReconciledSubagentSchema),
    }),
    handler: ({ queryParams }) => {
      const parentConversationId = queryParams?.parentConversationId;
      if (!parentConversationId) {
        throw new BadRequestError(
          "parentConversationId query parameter is required",
        );
      }
      const manager = getSubagentManager();
      const subagents: Record<
        string,
        z.infer<typeof ReconciledSubagentSchema>
      > = {};
      // Durable rows first, so the live pass below overwrites any id it also
      // holds. The retention sweep evicts terminal in-memory metadata while
      // deliberately keeping the row, so a run that completed more than a TTL
      // ago is absent from memory, and a client settling orphans by absence
      // would rewrite its `completed` entry to `interrupted`. That cover is
      // bounded rather than total: a completion older than the recent-terminal
      // window appears in neither pass, so a client settling by absence can
      // still re-mark it `interrupted`. Acceptable: a run that far back is no
      // longer surfaced anywhere else either.
      const records = getSubagentRecordsByParent(parentConversationId, {
        terminalStatuses: [...TERMINAL_STATUSES],
        maxTerminal: MAX_RECONCILED_TERMINAL_RECORDS,
      });
      for (const record of records) {
        const status = settledRecordStatus(record);
        if (!status) {
          continue;
        }
        subagents[record.id] = {
          status,
          conversationId: record.conversationId,
          label: record.label,
          objective: record.objective,
          isFork: record.isFork,
          parentToolUseId: record.parentToolUseId ?? undefined,
          usage: reportableUsage(record),
          error: record.error ?? undefined,
        };
      }

      // The live pass carries the same bound. `rehydrateFromDb()` applies a
      // much larger cap of its own, so for a whole retention window after a
      // restart the in-memory children of an old parent far outnumber what this
      // snapshot should ship.
      const liveChildren = manager.getChildrenOf(parentConversationId);
      const recentLive = new Set(
        boundRecentTerminal(liveChildren, MAX_RECONCILED_TERMINAL_RECORDS).map(
          (child) => child.config.id,
        ),
      );
      for (const child of liveChildren) {
        const id = child.config.id;
        // An id the durable pass already surfaced costs nothing to overwrite
        // with the fresher live state, it is in the payload either way.
        if (!recentLive.has(id) && subagents[id] === undefined) {
          continue;
        }
        subagents[id] = liveReconciledEntry(child);
      }
      return { subagents };
    },
  },

  {
    operationId: "getSubagentDetail",
    endpoint: "subagents/:id",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get subagent detail",
    description: "Return subagent objective and event history.",
    tags: ["subagents"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description:
          "The subagent's own conversation ID. Fallback only: when the " +
          "assistant knows the subagent (live, rehydrated, or in its durable " +
          "records), it resolves the conversation itself and this parameter " +
          "is ignored.",
      },
    ],
    responseBody: SubagentDetailResponseSchema,
    handler: ({ pathParams, queryParams }) => {
      const manager = getSubagentManager();
      const state = manager.getState(pathParams!.id);
      // Durable rows outlive manager state: the TTL sweep evicts in-memory
      // metadata but keeps the row, after a restart the row answers until
      // `rehydrateFromDb()` runs, and that rehydration rebuilds only the most
      // recently finished terminal subagents, so the row stays the only answer
      // for older ones. It supplies the conversation, label, status and spawn
      // anchor once the live state is gone.
      const record = state ? undefined : getSubagentRecordById(pathParams!.id);

      // Prefer the authoritative child-conversation id the daemon holds.
      // Clients recovering from a missed `subagent_spawned` only know the
      // PARENT conversation id (that's what `subagent_event` carries), so a
      // caller-supplied id may point at the wrong conversation entirely.
      const conversationId =
        state?.conversationId ??
        record?.conversationId ??
        queryParams?.conversationId;
      if (!conversationId) {
        throw new BadRequestError("conversationId query parameter is required");
      }

      return {
        ...getSubagentDetail(pathParams!.id, conversationId),
        conversationId,
        status:
          state?.status ?? (record ? settledRecordStatus(record) : undefined),
        label: state?.config.label ?? record?.label,
        parentToolUseId:
          state?.config.parentToolUseId ?? record?.parentToolUseId ?? undefined,
      };
    },
  },

  {
    operationId: "abortSubagent",
    endpoint: "subagents/:id/abort",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Abort subagent",
    description: "Abort a running subagent.",
    tags: ["subagents"],
    requestBody: z.object({
      conversationId: z.string(),
    }),
    responseBody: z.object({
      subagentId: z.string(),
      aborted: z.boolean(),
    }),
    handler: ({ pathParams, body }) => {
      const { conversationId } = (body ?? {}) as {
        conversationId?: string;
      };
      if (!conversationId || typeof conversationId !== "string") {
        throw new BadRequestError("conversationId is required");
      }

      const manager = getSubagentManager();
      const aborted = manager.abort(pathParams!.id, () => {}, conversationId);

      if (!aborted) {
        log.warn(
          { subagentId: pathParams!.id },
          "abort request for unknown or terminal subagent",
        );
        throw new NotFoundError(
          "Subagent not found or already in terminal state",
        );
      }

      return { subagentId: pathParams!.id, aborted: true };
    },
  },

  {
    operationId: "sendSubagentMessage",
    endpoint: "subagents/:id/message",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Send message to subagent",
    description: "Send a text message to a running subagent.",
    tags: ["subagents"],
    requestBody: z.object({
      conversationId: z.string(),
      content: z.string(),
    }),
    responseBody: z.object({
      subagentId: z.string(),
      sent: z.boolean(),
    }),
    handler: async ({ pathParams, body }) => {
      const { conversationId, content } = (body ?? {}) as {
        conversationId?: string;
        content?: string;
      };
      if (!conversationId || typeof conversationId !== "string") {
        throw new BadRequestError("conversationId is required");
      }
      if (!content || typeof content !== "string") {
        throw new BadRequestError("content is required");
      }

      const manager = getSubagentManager();

      const state = manager.getState(pathParams!.id);
      if (!state || state.config.parentConversationId !== conversationId) {
        throw new NotFoundError(
          `Subagent "${pathParams!.id}" not found or in terminal state.`,
        );
      }

      const result = await manager.sendMessage(pathParams!.id, content);

      if (result === "empty") {
        throw new BadRequestError(
          "Message content is empty or whitespace-only.",
        );
      } else if (result !== "sent") {
        throw new NotFoundError(
          `Subagent "${pathParams!.id}" not found or in terminal state.`,
        );
      }

      return { subagentId: pathParams!.id, sent: true };
    },
  },
];
