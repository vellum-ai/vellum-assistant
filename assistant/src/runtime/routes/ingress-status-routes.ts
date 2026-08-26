/**
 * Ingress status route: is the assistant's public tunnel actually up?
 *
 * The recorded `ingress.publicBaseUrl` only says a tunnel was configured at
 * some point. It stays behind in both directions: a killed tunnel leaves the
 * URL in place, and an edge can survive while the gateway behind it dies or
 * while it starts fronting a different assistant. This route resolves that by
 * probing the URL live (`inbound/tunnel-probe.ts`) and reporting one of six
 * states, so a client can tell the user what to do instead of guessing. The
 * card the states drive exists to pair devices, so an address that answers
 * without serving the pairing app is its own state (`unpairable`) rather than
 * a healthy one.
 *
 * Platform-hosted assistants receive webhooks through platform callback
 * routing and never run `vellum tunnel`, so they report `unconfigured`
 * rather than a tunnel state they cannot act on. A self-hosted gateway whose
 * Velay tunnel owns the URL is the same story one layer down: that URL
 * carries webhooks alone, so it is `unconfigured` for pairing too, and the
 * gateway publishes and restores it without a tunnel command either way.
 */
import { normalizePublicBaseUrl } from "@vellumai/service-contracts/ingress";
import { z } from "zod";

import {
  getIngressConfigResult,
  isVelayManagedIngress,
  loadPairingTunnelRecord,
  loadRecordedAssistantId,
  loadRestartTunnelRecord,
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
    "unpairable",
    "unreachable",
    "foreign",
  ]),
  publicBaseUrl: z
    .string()
    .optional()
    .describe(
      "The probed URL. Set for healthy, unpairable, unreachable, and foreign.",
    ),
  lastTunnel: z
    .object({ provider: z.string(), publicBaseUrl: z.string() })
    .optional()
    .describe(
      "The tunnel to restart. Set on stopped whenever one is recorded, and on unpairable, unreachable and foreign when the recorded tunnel fronted the configured URL.",
    ),
  servingAssistantName: z
    .string()
    .optional()
    .describe(
      "Name the edge serves under. Set for foreign when it reports one.",
    ),
  detail: z
    .string()
    .optional()
    .describe(
      "Short failure reason, free of the URL. Set for unreachable, and for unpairable when the edge gave one.",
    ),
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

  // A tunnel published for pairing alone is the address this route reports on:
  // it exists to answer the pairing card, and the `publicBaseUrl` beside it is
  // a webhook callback base that tunnel deliberately left in place. The user
  // owns and restarts that tunnel even where Velay owns the callback ingress.
  const pairingTunnel = loadPairingTunnelRecord();
  // A Velay-managed URL belongs to the gateway, which writes it, clears it,
  // and reconnects on its own, so there is no tunnel for the user to restart.
  // Velay's allowlist (`gateway/src/velay/allowed-paths.ts`) also exposes
  // neither `/healthz` nor the `/assistant/*` pairing surface, so that URL can
  // only ever probe as dead and prefills a page pairing cannot open. Without a
  // pairing tunnel beside it there is no address to report at all.
  if (isVelayManagedIngress() && !pairingTunnel) {
    return { state: "unconfigured" };
  }
  const lastTunnel = loadRestartTunnelRecord();

  const publicBaseUrl =
    pairingTunnel?.publicBaseUrl ?? config.publicBaseUrl.trim();
  if (!publicBaseUrl && !lastTunnel) {
    return { state: "unconfigured" };
  }
  // `ingress.enabled` governs callback ingress alone, and the URL survives
  // that toggle, so probing a callback base while ingress is opted out would
  // report an address the user switched off as healthy. A pairing tunnel is
  // published outside the toggle, so the opt-out says nothing about it. An
  // unset flag is not an opt-out either: a bring-your-own-HTTPS front sets
  // only the URL.
  if (!publicBaseUrl || (!pairingTunnel && config.explicitlyDisabled)) {
    return { state: "stopped", ...(lastTunnel ? { lastTunnel } : {}) };
  }

  // A record left over from an address that is no longer configured names a
  // tunnel that never fronted this one, so it is no help in getting back.
  const restartHint =
    lastTunnel &&
    normalizePublicBaseUrl(lastTunnel.publicBaseUrl) ===
      normalizePublicBaseUrl(publicBaseUrl)
      ? { lastTunnel }
      : {};

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
    // One remedy for both: start a tunnel that serves the web app.
    case "unpairable":
    case "unreachable":
      return {
        state: result.kind,
        ...checked,
        ...restartHint,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    case "foreign":
      return {
        state: "foreign",
        ...checked,
        ...restartHint,
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
      "Probe the configured public ingress URL and report whether a tunnel is serving this assistant. `unconfigured` means no tunnel has ever been recorded (or the ingress is managed for this assistant, as it is when platform-hosted or fronted by a Velay tunnel), `stopped` means a tunnel ran before and is not running now (callback ingress is explicitly switched off, or its URL is gone), `healthy` means the URL answers and fronts this assistant's web app, `unpairable` means it answers but does not serve that app, so a pairing link minted against it would not open, `unreachable` means it does not answer, and `foreign` means it answers for a different assistant. `lastTunnel` names the tunnel to restart, on the states where a recorded one applies to the configured URL.",
    tags: ["config"],
    handler: handleIngressStatus,
    responseBody: IngressStatusResponseSchema,
  },
];
