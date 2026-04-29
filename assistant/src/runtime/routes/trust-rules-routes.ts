/**
 * Trust rule listing route — gateway HTTP proxy.
 *
 * The handler makes a single HTTP call to the gateway's trust-rules REST API
 * and surfaces the body's `.error` message on non-OK responses.
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
];
