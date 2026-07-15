/**
 * ACP gateway-mode auth resolver (flag-gated, OFF by default).
 *
 * When the `acp-managed-proxy-routing` feature flag is enabled AND the managed
 * proxy prerequisites are met (platform base URL + assistant API key), returns
 * the config the ACP adapter's gateway auth mode needs to route a
 * platform-hosted `claude-agent-acp` child through the Vellum runtime proxy:
 * the proxy base URL plus the headers that authenticate the child as this
 * assistant. The child then needs no Anthropic credential of its own — billing
 * accrues per-assistant on the proxy.
 *
 * Returns `undefined` when the flag is off or the prereqs are missing, so every
 * caller falls back to the existing credential-injection path (no regression).
 *
 * The flag is OFF by default and requires a dev-platform live test before it is
 * enabled in production.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfigReadOnly } from "../config/loader.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../providers/platform-proxy/context.js";

/** Feature-flag key gating ACP managed-proxy (gateway auth) routing. */
export const ACP_MANAGED_PROXY_ROUTING_FLAG = "acp-managed-proxy-routing";

/** Adapter auth-method id for gateway routing (matches claude-agent-acp). */
export const GATEWAY_AUTH_METHOD_ID = "gateway";

// Runtime-proxy attribution header (mirrors providers/retry.ts). Non-secret.
const CALL_SITE_HEADER = "X-Vellum-LLM-Call-Site";
const CALL_SITE_VALUE = "acp-child";

export interface AcpGatewayAuth {
  baseUrl: string;
  headers: Record<string, string>;
}

/** Whether the ACP managed-proxy routing flag is enabled. */
export function isAcpManagedProxyRoutingEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(
    ACP_MANAGED_PROXY_ROUTING_FLAG,
    getConfigReadOnly(),
  );
}

/**
 * Resolve the gateway auth config when the gate is active (flag enabled AND
 * managed-proxy prereqs satisfied), else `undefined`.
 */
export async function resolveAcpGatewayAuth(): Promise<
  AcpGatewayAuth | undefined
> {
  if (!isAcpManagedProxyRoutingEnabled()) return undefined;

  const ctx = await resolveManagedProxyContext();
  if (!ctx.enabled) return undefined;

  const baseUrl = await buildManagedBaseUrl("anthropic");
  if (!baseUrl) return undefined;

  return {
    baseUrl,
    headers: {
      "x-api-key": ctx.assistantApiKey,
      [CALL_SITE_HEADER]: CALL_SITE_VALUE,
    },
  };
}
