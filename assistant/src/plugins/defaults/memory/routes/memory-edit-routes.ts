/**
 * Route handlers for memory edit endpoints.
 *
 * POST /v1/memory/delete — soft-delete a memory graph node by content match.
 * POST /v1/memory/update — correct an existing memory graph node in place.
 *
 * Both require guardian principal (settings.write scope) and memory v2.
 * These back the `vellum memory delete` and `vellum memory update` CLI
 * subcommands so users can manage memory without dedicated always-loaded
 * system tools.
 */

import { z } from "zod";

import { getConfig } from "../../../../config/loader.js";
import { ACTOR_PRINCIPALS } from "../../../../runtime/auth/route-policy.js";
import { BadRequestError } from "../../../../runtime/routes/errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../../../runtime/routes/types.js";
import { handleDeleteMemory, handleUpdateMemory } from "../graph/tool-handlers.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  content: z.string().min(1, "content is required"),
});

const updateSchema = z.object({
  old_content: z.string().min(1, "old_content is required"),
  new_content: z.string().min(1, "new_content is required"),
});

// ── Handlers ─────────────────────────────────────────────────────────────────

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
];
