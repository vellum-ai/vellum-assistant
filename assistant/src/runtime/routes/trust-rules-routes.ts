/**
 * Trust rule CRUD routes — gateway HTTP proxies.
 *
 * The handlers make a single HTTP call to the gateway's trust-rules REST
 * API and surface the body's `.error` message on non-OK responses.
 *
 * History: the mutation routes (create / update / delete / reset) were
 * removed by #28784 along with the CLI subcommands that called them.
 * That deletion left the macOS clients (which still call these endpoints
 * via `TrustRuleClient`) hitting 404 on Save Rule. Re-added here as
 * HTTP-facing proxies — the CLI commands are not restored.
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

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Schemas ─────────────────────────────────────────────────────────────

const TrustRulesListParams = z
  .object({
    tool: z.string().optional(),
    origin: z.string().optional(),
    include_all: z.boolean().optional(),
  })
  .strict();

// ── Handlers ────────────────────────────────────────────────────────────

async function handleList({ queryParams = {}, body = {} }: RouteHandlerArgs) {
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
  return gatewayFetch("/v1/trust-rules", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function handleUpdate({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const id = pathParams.id;
  if (!id) throw new Error("Missing rule id");
  return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

async function handleDelete({ pathParams = {} }: RouteHandlerArgs) {
  const id = pathParams.id;
  if (!id) throw new Error("Missing rule id");
  return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function handleReset({ pathParams = {} }: RouteHandlerArgs) {
  const id = pathParams.id;
  if (!id) throw new Error("Missing rule id");
  return gatewayFetch(
    `/v1/trust-rules/${encodeURIComponent(id)}/reset`,
    { method: "POST" },
  );
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
    description:
      "Create a user-defined trust rule. Body: { tool, pattern, risk, description }.",
    tags: ["trust-rules"],
  },
  {
    operationId: "trust_rules_update",
    method: "PATCH",
    endpoint: "trust-rules/:id",
    pathParams: [{ name: "id", description: "Trust rule ID" }],
    handler: handleUpdate,
    summary: "Update a trust rule",
    description:
      "Update a trust rule's risk and/or description. Body: { risk?, description? }.",
    tags: ["trust-rules"],
  },
  {
    operationId: "trust_rules_delete",
    method: "DELETE",
    endpoint: "trust-rules/:id",
    pathParams: [{ name: "id", description: "Trust rule ID" }],
    handler: handleDelete,
    summary: "Delete a trust rule",
    description: "Delete a user-defined trust rule by id.",
    tags: ["trust-rules"],
  },
  {
    operationId: "trust_rules_reset",
    method: "POST",
    endpoint: "trust-rules/:id/reset",
    pathParams: [{ name: "id", description: "Trust rule ID" }],
    // Collapse to the shared "trust-rules" policy entry. Without this
    // override the policy key would be "trust-rules/reset" — which is
    // not registered.
    policyKey: "trust-rules",
    handler: handleReset,
    summary: "Reset a default trust rule",
    description:
      "Reset a default-origin trust rule to its registry-defined risk and description.",
    tags: ["trust-rules"],
  },
];
