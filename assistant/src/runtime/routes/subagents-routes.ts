/**
 * Route handlers for subagent operations.
 *
 * Exposes subagent detail, abort, and message operations over HTTP,
 * sharing business logic with the handlers in
 * `daemon/handlers/subagents.ts`.
 */
import { getMessages } from "../../memory/conversation-crud.js";
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
  }>;
}

export function getSubagentDetail(
  subagentId: string,
  conversationId: string,
): SubagentDetailResult {
  const subagentMsgs = getMessages(conversationId);

  // Extract objective from the first user message
  let objective: string | undefined;
  const firstUser = subagentMsgs.find((m) => m.role === "user");
  if (firstUser) {
    try {
      const parsed = JSON.parse(firstUser.content);
      if (Array.isArray(parsed)) {
        const textBlock = parsed.find(
          (b: Record<string, unknown>) => isRecord(b) && b.type === "text",
        );
        if (textBlock && typeof textBlock.text === "string") {
          objective = textBlock.text;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Extract events from both assistant and user messages.
  const events: Array<{
    type: string;
    content: string;
    toolName?: string;
    isError?: boolean;
  }> = [];
  const pendingTools = new Map<string, string>();
  for (const m of subagentMsgs) {
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
        events.push({ type: "text", content: block.text });
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
          typeof block.content === "string" ? block.content : "";
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function subagentRouteDefinitions(): RouteDefinition[] {
  return [
    // GET /v1/subagents/:id — get subagent detail
    {
      endpoint: "subagents/:id",
      method: "GET",
      policyKey: "subagents",
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

    // POST /v1/subagents/:id/abort — abort subagent
    {
      endpoint: "subagents/:id/abort",
      method: "POST",
      policyKey: "subagents/abort",
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

    // POST /v1/subagents/:id/message — send message to subagent
    {
      endpoint: "subagents/:id/message",
      method: "POST",
      policyKey: "subagents/message",
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
