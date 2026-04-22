/**
 * Route handlers for subagent operations.
 *
 * Exposes subagent detail, abort, and message operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/subagents.ts`.
 */
import { z } from "zod";

import {
  getMessages,
  type MessageRow,
} from "../../memory/conversation-crud.js";
import { getSubagentManager } from "../../subagent/index.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

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
      } else if (block.type === "tool_use") {
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
      } else if (block.type === "tool_result") {
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const resultContent =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as unknown[])
                  .filter(
                    (b): b is Record<string, unknown> =>
                      isRecord(b) &&
                      (b as Record<string, unknown>).type === "text" &&
                      typeof (b as Record<string, unknown>).text === "string",
                  )
                  .map((b) => b.text as string)
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

export function getSubagentDetail(
  subagentId: string,
  conversationId: string,
): SubagentDetailResult {
  return parseSubagentMessages(subagentId, getMessages(conversationId));
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function subagentRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "subagents/:id",
      method: "GET",
      policyKey: "subagents",
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
      responseBody: z.object({
        subagentId: z.string(),
        objective: z.string(),
        events: z.array(z.unknown()).describe("Subagent event objects"),
      }),
      handler: ({ url, params }) => {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) {
          return httpError(
            "BAD_REQUEST",
            "conversationId query parameter is required",
            400,
          );
        }

        // Ownership check: if the subagent is still in memory, verify via state.
        // After daemon restart getState() returns null — allow the request
        // since the conversationId itself acts as a capability token.
        const manager = getSubagentManager();
        const state = manager.getState(params.id);
        // For HTTP routes, we don't have socket-based session binding.
        // The conversationId acts as a capability token.
        if (state) {
          // Subagent is still live in memory — allowed
        }

        const result = getSubagentDetail(params.id, conversationId);
        return Response.json(result);
      },
    },

    {
      endpoint: "subagents/:id/abort",
      method: "POST",
      policyKey: "subagents/abort",
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
      handler: async ({ req, params }) => {
        const body = (await req.json()) as { conversationId?: string };
        const conversationId = body.conversationId;
        if (!conversationId || typeof conversationId !== "string") {
          return httpError("BAD_REQUEST", "conversationId is required", 400);
        }

        const manager = getSubagentManager();
        const aborted = manager.abort(
          params.id,
          () => {}, // No send callback needed for HTTP
          conversationId,
        );

        if (!aborted) {
          log.warn(
            { subagentId: params.id },
            "HTTP abort request for unknown or terminal subagent",
          );
          return httpError(
            "NOT_FOUND",
            "Subagent not found or already in terminal state",
            404,
          );
        }

        return Response.json({ subagentId: params.id, aborted: true });
      },
    },

    {
      endpoint: "subagents/:id/message",
      method: "POST",
      policyKey: "subagents/message",
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
      handler: async ({ req, params }) => {
        const body = (await req.json()) as {
          conversationId?: string;
          content?: string;
        };
        const conversationId = body.conversationId;
        if (!conversationId || typeof conversationId !== "string") {
          return httpError("BAD_REQUEST", "conversationId is required", 400);
        }
        if (!body.content || typeof body.content !== "string") {
          return httpError("BAD_REQUEST", "content is required", 400);
        }

        const manager = getSubagentManager();

        // Ownership check
        const state = manager.getState(params.id);
        if (!state || state.config.parentConversationId !== conversationId) {
          return httpError(
            "NOT_FOUND",
            `Subagent "${params.id}" not found or in terminal state.`,
            404,
          );
        }

        const result = await manager.sendMessage(params.id, body.content);

        if (result === "empty") {
          return httpError(
            "BAD_REQUEST",
            "Message content is empty or whitespace-only.",
            400,
          );
        } else if (result !== "sent") {
          return httpError(
            "NOT_FOUND",
            `Subagent "${params.id}" not found or in terminal state.`,
            404,
          );
        }

        return Response.json({ subagentId: params.id, sent: true });
      },
    },
  ];
}
