/**
 * IPC surface for minting one-time credential-collection links.
 *
 * The daemon (settings page via its credential-requests route, and the
 * secret prompter's non-vellum-channel fallback) calls
 * `create_credential_request` over the gateway IPC socket. The gateway owns
 * all link/token state; the plaintext token leaves this process only inside
 * the returned URL.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { generateInviteToken, hashInviteToken } from "@vellumai/gateway-client";
import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import {
  CredentialRequestStore,
  MAX_ACTIVE_CREDENTIAL_REQUESTS,
} from "../db/credential-request-store.js";
import { isFeatureFlagEnabled } from "../feature-flag-resolver.js";
import { getLogger } from "../logger.js";
import { resolvePublicHttpBaseUrl } from "../runtime/client.js";
import { enablePublicIngress } from "../velay/client.js";
import type { IpcRoute } from "./server.js";

const log = getLogger("credential-requests");

const CREDENTIAL_REQUESTS_FLAG = "credential-requests";
export const DEFAULT_CREDENTIAL_REQUEST_TTL_MS = 30 * 60_000;
const MAX_CREDENTIAL_REQUEST_TTL_MS = 24 * 60 * 60_000;

// Sliding-window creation limiter (mirrors the remote-web pairing store).
const RATE_LIMIT_MAX_CREATIONS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const creationTimestamps: number[] = [];

function creationRateLimited(now: number): boolean {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  while (
    creationTimestamps.length > 0 &&
    creationTimestamps[0] <= windowStart
  ) {
    creationTimestamps.shift();
  }
  if (creationTimestamps.length >= RATE_LIMIT_MAX_CREATIONS) {
    return true;
  }
  creationTimestamps.push(now);
  return false;
}

export function resetCredentialRequestRateLimiterForTests(): void {
  creationTimestamps.length = 0;
}

const CreateCredentialRequestSchema = z.object({
  service: z.string().min(1),
  field: z.string().min(1),
  label: z.string().optional(),
  purpose: z.enum(["standalone", "prompt"]).optional(),
  secretPromptId: z.string().optional(),
  policyJson: z.string().optional(),
  ttlMs: z.number().int().positive().optional(),
});

export type CreateCredentialRequestResult =
  | { ok: true; token: string; url: string; expiresAt: number }
  | {
      ok: false;
      error:
        | "flag_disabled"
        | "no_public_base_url"
        | "rate_limited"
        | "too_many_active";
    };

export function createCredentialRequestIpcRoutes(
  config: GatewayConfig,
  configFile: ConfigFileCache,
  credentials: CredentialCache,
): IpcRoute[] {
  return [
    {
      method: "create_credential_request",
      schema: CreateCredentialRequestSchema,
      handler: async (params?: Record<string, unknown>) => {
        const parsed = CreateCredentialRequestSchema.parse(params ?? {});
        const platformAssistantId = (
          await credentials.get(
            credentialKey("vellum", "platform_assistant_id"),
          )
        )?.trim();
        return createCredentialRequest(
          config,
          configFile,
          parsed,
          platformAssistantId,
        );
      },
    },
  ];
}

export async function createCredentialRequest(
  config: GatewayConfig,
  configFile: ConfigFileCache,
  params: z.infer<typeof CreateCredentialRequestSchema>,
  platformAssistantId?: string,
): Promise<CreateCredentialRequestResult> {
  if (!isFeatureFlagEnabled(CREDENTIAL_REQUESTS_FLAG)) {
    return { ok: false, error: "flag_disabled" };
  }

  // Minting a credential link is an explicit request to expose the public
  // credential-entry page, so auto-enable public ingress when it was
  // explicitly disabled. Only flip an explicit `false` — a default `undefined`
  // already means "enabled" on platform (the Velay tunnel connects). Flipping
  // it lets the Velay reconnect loop establish the tunnel; the mint still
  // returns immediately using the resolved fallback URL below, and the link
  // becomes reachable within a few seconds once the tunnel registers.
  if (configFile.getBoolean("ingress", "enabled", { force: true }) === false) {
    await enablePublicIngress(configFile);
    log.info("Auto-enabled public ingress for credential link creation");
  }

  const publicBaseUrl = resolvePublicHttpBaseUrl(
    config,
    configFile,
    platformAssistantId,
  );
  if (!publicBaseUrl) {
    return { ok: false, error: "no_public_base_url" };
  }

  const now = Date.now();
  if (creationRateLimited(now)) {
    return { ok: false, error: "rate_limited" };
  }

  const store = new CredentialRequestStore();
  if (store.countActive(now) >= MAX_ACTIVE_CREDENTIAL_REQUESTS) {
    return { ok: false, error: "too_many_active" };
  }

  const ttlMs = Math.min(
    params.ttlMs ?? DEFAULT_CREDENTIAL_REQUEST_TTL_MS,
    MAX_CREDENTIAL_REQUEST_TTL_MS,
  );
  const token = generateInviteToken();
  const row = store.create({
    id: randomUUID(),
    tokenHash: hashInviteToken(token),
    purpose: params.purpose ?? "standalone",
    service: params.service,
    field: params.field,
    label: params.label ?? null,
    secretPromptId: params.secretPromptId ?? null,
    policyJson: params.policyJson ?? null,
    expiresAt: now + ttlMs,
  });

  log.info(
    {
      requestId: row.id,
      service: row.service,
      field: row.field,
      purpose: row.purpose,
      expiresAt: row.expiresAt,
    },
    "Credential request minted",
  );

  // The token rides in the URL FRAGMENT: browsers never send fragments over
  // HTTP, so it cannot land in reverse-proxy/access logs or Referer headers.
  return {
    ok: true,
    token,
    url: `${publicBaseUrl}/assistant/credentials/enter#token=${encodeURIComponent(token)}`,
    expiresAt: row.expiresAt,
  };
}
