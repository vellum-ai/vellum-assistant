/**
 * Route handlers for subagent operations.
 *
 * Exposes subagent detail, abort, and message operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/subagents.ts`.
 */
import { z } from "zod";

import { SubagentDetailResponseSchema } from "../../api/responses/subagent-detail.js";
import {
  getMessages,
  type MessageRow,
} from "../../memory/conversation-crud.js";
import { getConversationUsageTotals } from "../../memory/llm-usage-store.js";
import { getSubagentManager } from "../../subagent/index.js";
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
      const parsed = JSON.parse(firstUser.content);
      if (Array.isArray(parsed)) {
        const textBlock = parsed.find(
          (b: Record<string, unknown>) => isRecord(b) && b.type === "text",
        );
        if (textBlock && typeof textBlock.text === "string") {
          objective = stripForkDirectiveFraming(textBlock.text);
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Extract events from both assistant and user messages.
  const events: SubagentDetailResult["events"] = [];
  const pendingTools = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" && m.role !== "user") continue;
    let content: unknown[];
    try {
      const parsed = JSON.parse(m.content);
      content = Array.isArray(parsed) ? parsed : [];
    } catch {
      continue;
    }

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
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
        });
        if (id) pendingTools.set(id, name);
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
                    if (b.type === "text" && typeof b.text === "string")
                      return b.text;
                    if (
                      b.type === "web_search_result" &&
                      typeof b.title === "string"
                    )
                      return `${b.title}\n${typeof b.url === "string" ? b.url : ""}`;
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
  log.info(
    {
      subagentId,
      conversationId,
      messageCount: messages.length,
      roles: messages.map((m) => m.role),
    },
    "getSubagentDetail: raw messages from DB",
  );
  const result = parseSubagentMessages(subagentId, messages);
  log.info(
    {
      subagentId,
      eventCount: result.events.length,
      eventTypes: result.events.map((e) => `${e.type}:${e.toolName ?? ""}`),
    },
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
      "Returns the live in-memory status of all subagents known to the daemon for a given parent conversation. Subagents not in the response are orphaned.",
    tags: ["subagents"],
    queryParams: [
      {
        name: "parentConversationId",
        schema: { type: "string" },
        description: "Parent conversation ID",
      },
    ],
    responseBody: z.object({
      subagents: z.record(
        z.string(),
        z.object({
          status: z.string(),
        }),
      ),
    }),
    handler: ({ queryParams }) => {
      const parentConversationId = queryParams?.parentConversationId;
      if (!parentConversationId) {
        throw new BadRequestError(
          "parentConversationId query parameter is required",
        );
      }
      const manager = getSubagentManager();
      const children = manager.getChildrenOf(parentConversationId);
      const subagents: Record<string, { status: string }> = {};
      for (const child of children) {
        subagents[child.config.id] = { status: child.status };
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
        description: "Parent conversation ID (required)",
      },
    ],
    responseBody: SubagentDetailResponseSchema,
    handler: ({ pathParams, queryParams }) => {
      const conversationId = queryParams?.conversationId;
      if (!conversationId) {
        throw new BadRequestError("conversationId query parameter is required");
      }

      const manager = getSubagentManager();
      const state = manager.getState(pathParams!.id);

      return {
        ...getSubagentDetail(pathParams!.id, conversationId),
        status: state?.status,
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
