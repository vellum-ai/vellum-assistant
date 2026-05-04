/**
 * Gateway log tail route — gateway HTTP proxy.
 *
 * The handler makes a single HTTP call to the gateway's log-tail API
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

const LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const GatewayLogsTailParams = z
  .object({
    n: z.coerce.number().int().min(1).max(1000).optional(),
    level: z.enum(LEVEL_NAMES).optional(),
    module: z.string().optional(),
  })
  .strict();

// ── Handlers ────────────────────────────────────────────────────────────

async function handleGatewayLogsTail({ queryParams = {}, body = {} }: RouteHandlerArgs) {
  // HTTP GET delivers filters via queryParams; CLI IPC puts them in body.
  const source = Object.keys(queryParams).length > 0 ? queryParams : body;
  const p = GatewayLogsTailParams.parse(source);
  const qs = new URLSearchParams();
  if (p.n !== undefined) qs.set("n", String(p.n));
  if (p.level !== undefined) qs.set("level", p.level);
  if (p.module !== undefined) qs.set("module", p.module);
  const query = qs.toString();
  return gatewayFetch(`/v1/logs/tail${query ? `?${query}` : ""}`);
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "gateway_logs_tail",
    method: "GET",
    endpoint: "gateway/logs/tail",
    handler: handleGatewayLogsTail,
    summary: "Tail gateway log entries",
    description:
      "Return the last N structured log entries from the gateway log files.",
    tags: ["gateway-logs"],
    queryParams: [
      { name: "n", description: "Number of lines to return (1–1000, default: 10)" },
      { name: "level", description: "Minimum pino level name (default: info)" },
      { name: "module", description: "Filter to exact pino module name" },
    ],
  },
];
