/**
 * Ingress status route: is the assistant's public tunnel actually up?
 *
 * The recorded `ingress.publicBaseUrl` only says a tunnel was configured at
 * some point. It stays behind in both directions: a killed tunnel leaves the
 * URL in place, and an edge can survive while the gateway behind it dies or
 * while it starts fronting a different assistant. This route resolves that by
 * probing the URL live (`inbound/tunnel-probe.ts`) and reporting one of five
 * states, so a client can tell the user what to do instead of guessing.
 *
 * Platform-hosted assistants receive webhooks through platform callback
 * routing and never run `vellum tunnel`, so they report `unconfigured`
 * rather than a tunnel state they cannot act on.
 */
import { z } from "zod";

import {
  getIngressConfigResult,
  loadLastTunnelRecord,
  loadRecordedAssistantId,
} from "../../daemon/handlers/config-ingress.js";
import { probeTunnel } from "../../inbound/tunnel-probe.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────────

/**
 * Flat rather than a union on `state` so the generated client SDK stays a
 * single type; which fields are populated follows from `state`.
 */
const IngressStatusResponseSchema = z.object({
  state: z.enum([
    "unconfigured",
    "stopped",
    "healthy",
    "unreachable",
    "foreign",
  ]),
  publicBaseUrl: z
    .string()
    .optional()
    .describe("The probed URL. Set for healthy, unreachable, and foreign."),
  lastTunnel: z
    .object({ provider: z.string(), publicBaseUrl: z.string() })
    .optional()
    .describe("The tunnel to restart. Set for stopped."),
  servingAssistantName: z
    .string()
    .optional()
    .describe(
      "Name the edge serves under. Set for foreign when it reports one.",
    ),
  detail: z
    .string()
    .optional()
    .describe("Short failure reason, free of the URL. Set for unreachable."),
  checkedAt: z
    .string()
    .optional()
    .describe("ISO-8601 instant the probe finished. Set whenever one ran."),
});
type IngressStatusResponse = z.infer<typeof IngressStatusResponseSchema>;

// ── Handlers ────────────────────────────────────────────────────────────

async function handleIngressStatus(): Promise<IngressStatusResponse> {
  const config = getIngressConfigResult();
  if (config.managedCallbacks) {
    return { state: "unconfigured" };
  }

  const publicBaseUrl = config.publicBaseUrl.trim();
  if (!publicBaseUrl) {
    const lastTunnel = loadLastTunnelRecord();
    return lastTunnel
      ? { state: "stopped", lastTunnel }
      : { state: "unconfigured" };
  }

  // Omitted when unrecorded so the probe skips the identity check entirely
  // rather than reading every served id as a mismatch.
  const expectedAssistantId = loadRecordedAssistantId();
  const result = await probeTunnel({
    publicBaseUrl,
    ...(expectedAssistantId ? { expectedAssistantId } : {}),
  });
  const checked = { publicBaseUrl, checkedAt: new Date().toISOString() };

  switch (result.kind) {
    case "healthy":
      return { state: "healthy", ...checked };
    case "unreachable":
      return { state: "unreachable", ...checked, detail: result.detail };
    case "foreign":
      return {
        state: "foreign",
        ...checked,
        ...(result.assistantName
          ? { servingAssistantName: result.assistantName }
          : {}),
      };
  }
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_ingress_status",
    endpoint: "integrations/ingress/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get ingress tunnel status",
    description:
      "Probe the configured public ingress URL and report whether a tunnel is serving this assistant. `unconfigured` means no tunnel has ever been recorded (or the assistant is platform-hosted, which never uses one), `stopped` means a tunnel ran before and `lastTunnel` names it, `healthy` means the URL answers and fronts this assistant, `unreachable` means it does not answer, and `foreign` means it answers for a different assistant.",
    tags: ["config"],
    handler: handleIngressStatus,
    responseBody: IngressStatusResponseSchema,
  },
];
