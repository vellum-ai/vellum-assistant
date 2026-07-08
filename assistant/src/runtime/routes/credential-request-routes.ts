/**
 * Route for minting one-time credential-collection links.
 *
 * The gateway owns all link/token state (`credential_requests` in the gateway
 * DB); this route is the daemon-side surface that the web settings page and
 * CLI call. It forwards to the gateway's `create_credential_request` IPC
 * method and relays the result. The returned URL points at the public
 * credential-entry page served from the gateway's public ingress base.
 */

import { z } from "zod";

import { ipcCall } from "../../ipc/gateway-client.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const CreateCredentialRequestParams = z.object({
  service: z.string().min(1),
  field: z.string().min(1),
  label: z.string().optional(),
});

type GatewayMintResult =
  | { ok: true; token: string; url: string; expiresAt: number }
  | { ok: false; error: string };

const MINT_ERROR_MESSAGES: Record<string, string> = {
  flag_disabled: "One-time credential links are not enabled",
  no_public_base_url:
    "No public ingress URL is configured — set ingress.publicBaseUrl first",
  rate_limited: "Too many credential links created — try again in a minute",
  too_many_active:
    "Too many unredeemed credential links — wait for some to expire",
};

async function handleCreateCredentialRequest({ body = {} }: RouteHandlerArgs) {
  const validated = CreateCredentialRequestParams.parse(body);

  const result = (await ipcCall("create_credential_request", {
    service: validated.service,
    field: validated.field,
    label: validated.label,
  })) as GatewayMintResult | undefined;

  if (!result) {
    return { ok: false, error: "The gateway is not reachable" };
  }
  if (!result.ok) {
    return {
      ok: false,
      error: MINT_ERROR_MESSAGES[result.error] ?? result.error,
    };
  }
  return {
    ok: true,
    url: result.url,
    token: result.token,
    expiresAt: result.expiresAt,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "credential_requests_create",
    endpoint: "credential-requests",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleCreateCredentialRequest,
    summary: "Mint a one-time credential-collection link",
    description:
      "Create a single-use tokenized URL that collects one credential value via the public credential-entry page. Link state lives in the gateway; the value is stored via the credential vault on submission.",
    tags: ["credentials"],
    requestBody: CreateCredentialRequestParams,
    responseBody: z.object({
      ok: z.boolean(),
      url: z.string().optional(),
      token: z.string().optional(),
      expiresAt: z.number().optional(),
      error: z.string().optional(),
    }),
  },
];
