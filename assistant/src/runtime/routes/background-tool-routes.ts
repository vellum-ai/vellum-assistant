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
  listCompletedBackgroundTools,
} from "../../tools/background-tool-registry.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Handlers ──────────────────────────────────────────────────────────

async function handleBackgroundToolList({
  queryParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId || undefined;
  const tools = listBackgroundTools(conversationId);
  const completed = listCompletedBackgroundTools(conversationId);

  return {
    tools: tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      conversationId: t.conversationId,
      command: t.command,
      startedAt: t.startedAt,
    })),
    // Recently-completed tools let a client that missed the live completion
    // event (chat unmounted / different conversation active) recover the
    // terminal status on rehydration instead of wrongly retiring as cancelled.
    completed: completed.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      conversationId: t.conversationId,
      command: t.command,
      startedAt: t.startedAt,
      status: t.status,
      exitCode: t.exitCode,
      output: t.output,
      completedAt: t.completedAt,
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

const CompletedBackgroundToolSchema = BackgroundToolSchema.extend({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().nullable(),
  output: z.string(),
  completedAt: z.number(),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "background_tool_list",
    endpoint: "background-tools",
    method: "GET",
    // Read path for the chat UI's background-task rehydration, like the ACP
    // `acp_list_sessions` route — so the web actor (not just a local CLI
    // caller) can re-seed inline cards on reload.
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      completed: z.array(CompletedBackgroundToolSchema),
    }),
  },
  {
    operationId: "background_tool_cancel",
    endpoint: "background-tools/cancel",
    method: "POST",
    // Write path for the inline card's Stop button, like ACP `acp_cancel` —
    // the web actor cancels a running task it can see.
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
