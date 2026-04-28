/**
 * Transport-agnostic routes for listing and cancelling background tools.
 *
 * Background tools are long-running processes (e.g. bash, host_bash) that the
 * agent spawns in the background. These routes expose visibility and control
 * over active background tool executions.
 */

import { z } from "zod";

import {
  cancelBackgroundTool,
  listBackgroundTools,
} from "../../tools/background-tool-registry.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ──────────────────────────────────────────────────────────

async function handleBackgroundToolList({
  queryParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId || undefined;
  const tools = listBackgroundTools(conversationId);

  return {
    tools: tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      conversationId: t.conversationId,
      command: t.command,
      startedAt: t.startedAt,
    })),
  };
}

async function handleBackgroundToolCancel({ body = {} }: RouteHandlerArgs) {
  const id = body.id as string | undefined;
  if (!id) {
    throw new BadRequestError("id is required");
  }

  const cancelled = cancelBackgroundTool(id);
  return { cancelled };
}

// ── Routes ────────────────────────────────────────────────────────────

const BackgroundToolSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  conversationId: z.string(),
  command: z.string(),
  startedAt: z.number(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "background_tool_list",
    endpoint: "background-tools",
    method: "GET",
    handler: handleBackgroundToolList,
    summary: "List active background tools",
    description:
      "List all active background tool executions, optionally filtered by conversationId.",
    tags: ["background-tools"],
    queryParams: [
      {
        name: "conversationId",
        type: "string",
        required: false,
        description: "Filter by conversation ID",
      },
    ],
    responseBody: z.object({
      tools: z.array(BackgroundToolSchema),
    }),
  },
  {
    operationId: "background_tool_cancel",
    endpoint: "background-tools/cancel",
    method: "POST",
    handler: handleBackgroundToolCancel,
    summary: "Cancel a background tool",
    description: "Cancel an active background tool execution by ID.",
    tags: ["background-tools"],
    requestBody: z.object({
      id: z.string(),
    }),
    responseBody: z.object({
      cancelled: z.boolean(),
    }),
  },
];
