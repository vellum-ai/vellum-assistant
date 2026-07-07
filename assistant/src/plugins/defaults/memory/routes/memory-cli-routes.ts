/**
 * Route handlers for memory management CLI endpoints.
 *
 * POST /v1/memory/delete — soft-delete a memory graph node by content match.
 * POST /v1/memory/update — correct an existing memory graph node in place.
 * GET  /v1/memory/list   — list active memory nodes with optional search.
 *
 * All three require guardian principal (settings.read/write scope) and back
 * the `vellum memory` CLI subcommands so users can manage memory without
 * the web UI.
 */

import { z } from "zod";

import { getConfig } from "../../../../config/loader.js";
import { ACTOR_PRINCIPALS } from "../../../../runtime/auth/route-policy.js";
import { BadRequestError } from "../../../../runtime/routes/errors.js";
import type {
  RouteDefinition,
  RouteHandlerArgs,
} from "../../../../runtime/routes/types.js";
import {
  handleDeleteMemory,
  handleListMemory,
  handleUpdateMemory,
} from "../graph/tool-handlers.js";

// ── delete ────────────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  content: z.string().min(1, "content is required"),
});

async function memoryDelete({
  body,
}: RouteHandlerArgs): Promise<{ success: boolean; message: string }> {
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]!.message);
  }

  const result = handleDeleteMemory(
    { content: parsed.data.content },
    getConfig(),
  );
  if (!result.success) {
    throw new BadRequestError(result.message);
  }
  return { success: true, message: result.message };
}

// ── update ────────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  old_content: z.string().min(1, "old_content is required"),
  new_content: z.string().min(1, "new_content is required"),
});

async function memoryUpdate({
  body,
}: RouteHandlerArgs): Promise<{ success: boolean; message: string }> {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]!.message);
  }

  const result = handleUpdateMemory(
    {
      old_content: parsed.data.old_content,
      new_content: parsed.data.new_content,
    },
    "cli",
    getConfig(),
  );
  if (!result.success) {
    throw new BadRequestError(result.message);
  }
  return { success: true, message: result.message };
}

// ── list ──────────────────────────────────────────────────────────────────────

async function memoryList({ queryParams }: RouteHandlerArgs): Promise<{
  nodes: {
    id: string;
    content: string;
    type: string;
    fidelity: string;
    created: number;
  }[];
  total: number;
}> {
  const search = queryParams?.search ?? undefined;
  const limitRaw = Number(queryParams?.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  const result = handleListMemory({ search, limit }, getConfig());
  return { nodes: result.nodes, total: result.total };
}

// ── Route definitions ─────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_delete",
    endpoint: "memory/delete",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: memoryDelete,
    summary: "Delete a memory node by content match",
    tags: ["memory"],
    requestBody: z.object({ content: z.string().min(1) }),
    responseBody: z.object({ success: z.boolean(), message: z.string() }),
  },
  {
    operationId: "memory_update",
    endpoint: "memory/update",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: memoryUpdate,
    summary: "Update a memory node in place",
    tags: ["memory"],
    requestBody: z.object({
      old_content: z.string().min(1),
      new_content: z.string().min(1),
    }),
    responseBody: z.object({ success: z.boolean(), message: z.string() }),
  },
  {
    operationId: "memory_list",
    endpoint: "memory/list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: memoryList,
    summary: "List active memory nodes",
    tags: ["memory"],
    queryParams: [
      {
        name: "search",
        schema: { type: "string" },
        description: "Substring filter on content",
      },
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max results (default 50, max 200)",
      },
    ],
    responseBody: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          content: z.string(),
          type: z.string(),
          fidelity: z.string(),
          created: z.number(),
        }),
      ),
      total: z.number(),
    }),
  },
];
