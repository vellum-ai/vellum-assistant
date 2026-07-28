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
} from "../../persistence/subagent-store.js";
import { getSubagentManager } from "../../subagent/index.js";
import { TERMINAL_STATUSES } from "../../subagent/types.js";
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
  const usage = getConversationUsageTotals(conversationId);
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
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
   * `subagent_status_changed` event — which is exactly the event a
   * reconciling client may have missed. Carried here so the snapshot can
   * restore final token/cost totals and a failure reason instead of leaving
   * them owned by a lost event.
   */
  usage: SubagentUsageStatsSchema.optional(),
  error: z.string().optional(),
});

/**
 * Settle the status of a durable row that no live manager entry answers for.
 *
 * Invariant: a subagent runs from an in-memory entry, so a durable row without
 * one can only describe a run that is no longer executing — whatever the row
 * says, nothing is driving it. Its pre-crash `pending`/`running`/
 * `awaiting_input` is therefore stale and reported as `interrupted`, exactly
 * what `SubagentManager.rehydrateFromDb()` writes for the same row. Terminal
 * statuses are the truth already and pass through untouched.
 *
 * This closes a startup window rather than a steady state: `setDbReady(true)`
 * precedes `rehydrateFromDb()` in `daemon/lifecycle.ts`, so a request can pass
 * the DB gate while the manager is still empty and read rows the rehydration
 * has not yet normalized. Without the coercion a client reconciling on its SSE
 * reopen adopts `running`, and the later rehydration flips the row to
 * `interrupted` with no status event to say so — leaving the UI stuck.
 *
 * Only ever applied to record-derived statuses; live state is authoritative
 * and never coerced.
 */
function settledDurableStatus(status: SubagentStatus): SubagentStatus {
  return TERMINAL_STATUSES.has(status) ? status : "interrupted";
}

/**
 * A child that has spent nothing reports no usage at all, matching the detail
 * route — an all-zero snapshot tells a client nothing its own tally doesn't
 * already say.
 */
function reconciledUsage(usage: {
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
      "Returns every subagent the assistant knows for a given parent conversation — live, rehydrated, and durably recorded, including terminal runs whose in-memory metadata the retention sweep has already evicted. Each entry carries enough detail (child conversation id, label, objective, token usage, failure reason) for a client to rebuild its subagent list from scratch, not just refresh statuses. A subagent absent from the response is one the assistant has no knowledge of at all, so a client may settle its own stuck-active entries against this snapshot. Only `status` is guaranteed to be present; every other field is optional.",
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
      // ago is absent from memory — and a client settling orphans by absence
      // would rewrite its `completed` entry to `interrupted`.
      for (const record of getSubagentRecordsByParent(parentConversationId)) {
        // `SubagentRecord.status` is an untyped column; the response contract
        // is the closed enum, so drop what doesn't parse rather than widening
        // the wire type.
        const status = SubagentStatusSchema.safeParse(record.status);
        if (!status.success) {
          continue;
        }
        subagents[record.id] = {
          // Coerced here, before the live pass below overwrites any id the
          // manager also holds — so only genuinely orphaned rows keep it.
          status: settledDurableStatus(status.data),
          conversationId: record.conversationId,
          label: record.label,
          objective: record.objective,
          isFork: record.isFork,
          parentToolUseId: record.parentToolUseId ?? undefined,
          usage: reconciledUsage(record),
          error: record.error ?? undefined,
        };
      }

      for (const child of manager.getChildrenOf(parentConversationId)) {
        subagents[child.config.id] = {
          status: child.status,
          conversationId: child.conversationId,
          label: child.config.label,
          objective: child.config.objective,
          isFork: child.isFork,
          parentToolUseId: child.config.parentToolUseId,
          usage: child.usage ? reconciledUsage(child.usage) : undefined,
          error: child.error,
        };
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
          "The subagent's own conversation ID. Fallback only — when the " +
          "assistant knows the subagent (live, rehydrated, or in its durable " +
          "records), it resolves the conversation itself and this parameter " +
          "is ignored.",
      },
    ],
    responseBody: SubagentDetailResponseSchema,
    handler: ({ pathParams, queryParams }) => {
      const manager = getSubagentManager();
      const state = manager.getState(pathParams!.id);
      // Durable rows outlive manager state — the TTL sweep evicts in-memory
      // metadata but keeps the row, and after a restart the row answers until
      // `rehydrateFromDb()` runs — so they supply the conversation, label and
      // status once the live state is gone.
      const record = state ? undefined : getSubagentRecordById(pathParams!.id);
      // `SubagentRecord.status` is an untyped column; the response contract is
      // the closed `SubagentStatusSchema` enum. Drop anything that doesn't
      // parse rather than widening the wire type.
      const recordStatus = record
        ? SubagentStatusSchema.safeParse(record.status)
        : undefined;

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
        // `record` is only read when the manager has no state, so a
        // record-derived status is by definition orphaned and gets settled.
        status:
          state?.status ??
          (recordStatus?.success
            ? settledDurableStatus(recordStatus.data)
            : undefined),
        label: state?.config.label ?? record?.label,
        parentToolUseId: state?.config.parentToolUseId,
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
