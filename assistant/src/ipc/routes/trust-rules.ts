/**
 * IPC proxy routes for trust rule CRUD.
 *
 * Each route makes a single HTTP call to the gateway's trust-rules API and
 * surfaces the body's `.error` message on non-OK responses.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import type { IpcRoute } from "../assistant-server.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const trustRuleRoutes: IpcRoute[] = [
  {
    method: "trust_rules_list",
    handler: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const qs = new URLSearchParams();
      if (typeof p.tool === "string") qs.set("tool", p.tool);
      if (typeof p.origin === "string") qs.set("origin", p.origin);
      if (p.include_all === true) qs.set("include_all", "true");
      const query = qs.toString();
      return gatewayFetch(`/v1/trust-rules${query ? `?${query}` : ""}`);
    },
  },
  {
    method: "trust_rules_create",
    handler: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const { tool, pattern, risk, description } = p;
      return gatewayFetch("/v1/trust-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, pattern, risk, description }),
      });
    },
  },
  {
    method: "trust_rules_update",
    handler: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = String(p?.id ?? "");
      if (!id) throw new Error("id is required");
      const body: Record<string, unknown> = {};
      if ("risk" in p) body.risk = p.risk;
      if ("description" in p) body.description = p.description;
      return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  },
  {
    method: "trust_rules_remove",
    handler: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = String(p?.id ?? "");
      if (!id) throw new Error("id is required");
      return gatewayFetch(`/v1/trust-rules/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  },
];
