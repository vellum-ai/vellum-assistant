/**
 * Trust rule CRUD routes — gateway HTTP proxy.
 *
 * Each handler makes a single HTTP call to the gateway's trust-rules REST API
 * and surfaces the body's `.error` message on non-OK responses.
 *
 * Migrated from `ipc/routes/trust-rules.ts` into the shared ROUTES array.
 */
import { z } from "zod";

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Shared helper ───────────────────────────────────────────────────────

async function gatewayFetch(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = getGatewayInternalBaseUrl();
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    let message = `Gateway request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // ignore JSON parse failures
    }
    throw new Error(message);
  }
  return res.json();
}

// ── Schemas ─────────────────────────────────────────────────────────────

const TrustRulesListParams = z
  .object({
    tool: z.string().optional(),
    origin: z.string().optional(),
    include_all: z.boolean().optional(),
  })
  .strict();

const TrustRulesCreateParams = z
  .object({
    tool: z.string(),
    pattern: z.string(),
    risk: z.string(),
    description: z.string().optional(),
  })
  .strict();

const TrustRulesUpdateBody = z
  .object({
    risk: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

// ── Handlers ────────────────────────────────────────────────────────────

async function handleList({
  queryParams = {},
  body = {},
}: RouteHandlerArgs) {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = TrustRulesListParams.parse(source);
  const qs = new URLSearchParams();
  if (p.tool) qs.set("tool", p.tool);
  if (p.origin) qs.set("origin", p.origin);
  if (p.include_all) qs.set("include_all", "true");
  const query = qs.toString();
  return gatewayFetch(`/v1/trust-rules${query ? `?${query}` : ""}`);
}

async function handleCreate({ body = {} }: RouteHandlerArgs) {
  const { tool, pattern, risk, description } = TrustRulesCreateParams.parse(body);
  return gatewayFetch("/v1/trust-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, pattern, risk, description }),
  });
}

async function handleUpdate({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  // HTTP path delivers id via pathParams; CLI IPC puts it in body.
  const rawBody = body as Record<string, unknown>;
  const id = pathParams.id ?? rawBody.id;
  if (!id || typeof id !== "string") throw new Error("id is required");
  const { id: _discarded, ...rest } = rawBody;
  const fields = TrustRulesUpdateBody.parse(rest);
  const patchBody: Record<string, unknown> = {};
  if (fields.risk !== undefined) patchBody.risk = fields.risk;
  if (fields.description !== undefined) patchBody.description = fields.description;
  return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
}

async function handleRemove({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  // HTTP path delivers id via pathParams; CLI IPC puts it in body.
  const id = pathParams.id ?? (body as Record<string, unknown>).id;
  if (!id || typeof id !== "string") throw new Error("id is required");
  return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "trust_rules_list",
    method: "GET",
    endpoint: "trust-rules",
    handler: handleList,
    summary: "List trust rules",
    description:
      "List trust rules, optionally filtered by tool, origin, or include_all.",
    tags: ["trust-rules"],
    queryParams: [
      { name: "tool", description: "Filter by tool name" },
      { name: "origin", description: "Filter by origin" },
      { name: "include_all", description: "Include unmodified defaults" },
    ],
  },
  {
    operationId: "trust_rules_create",
    method: "POST",
    endpoint: "trust-rules",
    handler: handleCreate,
    summary: "Create a trust rule",
    description: "Create a new trust rule with tool, pattern, risk level, and optional description.",
    tags: ["trust-rules"],
    requestBody: TrustRulesCreateParams,
  },
  {
    operationId: "trust_rules_update",
    method: "PATCH",
    endpoint: "trust-rules/:id",
    handler: handleUpdate,
    summary: "Update a trust rule",
    description: "Update the risk level or description of an existing trust rule.",
    tags: ["trust-rules"],
    requestBody: TrustRulesUpdateBody,
  },
  {
    operationId: "trust_rules_remove",
    method: "DELETE",
    endpoint: "trust-rules/:id",
    handler: handleRemove,
    summary: "Remove a trust rule",
    description: "Delete a trust rule by ID.",
    tags: ["trust-rules"],
  },
];
