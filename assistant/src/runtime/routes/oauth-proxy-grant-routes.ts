/**
 * Mints the short-lived grant a third-party CLI presents to the OAuth
 * passthrough proxy (`oauth_proxy_*`).
 *
 * The grant names one provider, and the account it resolved to, in its subject
 * and carries the `oauth_proxy_v1` profile, so it opens the proxy route for
 * that one connection and nothing else. The provider credential never leaves
 * the daemon.
 */

import { z } from "zod";

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import type { OAuthConnectionResolution } from "../../oauth/connection-resolver.js";
import { resolveOAuthConnectionWithMeta } from "../../oauth/connection-resolver.js";
import { getProvider } from "../../oauth/oauth-store.js";
import { getLogger } from "../../util/logger.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { mintToken } from "../auth/token-service.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import {
  ambiguousConnectionError,
  encodeProxyProviderSegment,
  mapProxyResolveError,
  proxyGrantSubject,
} from "./oauth-proxy-passthrough.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("oauth-proxy-grant-routes");

/** Long enough for a CLI run, short enough that a leaked grant expires fast. */
const DEFAULT_TTL_SECONDS = 900;

const GrantRequestSchema = z.object({
  provider: z.string().min(1),
  account: z.string().min(1).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

const GrantResponseSchema = z.object({
  ok: z.literal(true),
  provider: z.string(),
  account: z.string().nullable(),
  baseUrl: z.string(),
  path: z.string(),
  token: z.string(),
  expiresAt: z.string(),
  ttlSeconds: z.number(),
});

type OAuthProxyGrantResponse = z.infer<typeof GrantResponseSchema>;

export async function handleOAuthProxyGrant({
  body = {},
}: RouteHandlerArgs): Promise<OAuthProxyGrantResponse> {
  const parsed = GrantRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0].message);
  }
  const { provider, account, ttlSeconds = DEFAULT_TTL_SECONDS } = parsed.data;

  if (!getProvider(provider)) {
    throw new NotFoundError(
      `Unknown provider "${provider}". Run 'assistant oauth providers list' to see available providers.`,
    );
  }

  // Resolving here means the caller is told to pick an account before any
  // provider call is made with the grant. This route answers the local
  // principal that owns the connections, so its errors name them.
  let resolution: OAuthConnectionResolution;
  try {
    resolution = await resolveOAuthConnectionWithMeta(
      provider,
      account ? { account } : undefined,
    );
  } catch (err) {
    throw mapProxyResolveError(err, provider, "operator");
  }
  if (resolution.ambiguous) {
    throw ambiguousConnectionError(
      provider,
      resolution.allAccounts,
      "operator",
    );
  }

  // The pinned account is named by the subject as well as by the segment, so
  // the proxy refuses this grant against any other account of the provider.
  const pinnedAccount = account ?? resolution.connection.accountInfo ?? null;

  // Built before the token so a provider key or account the subject cannot
  // hold fails with a 400 rather than yielding a grant that never verifies.
  const segment = encodeProxyProviderSegment(
    provider,
    pinnedAccount ?? undefined,
  );

  // The gateway validates the edge token and re-mints a daemon token with the
  // same subject and profile; the daemon middleware also accepts this audience
  // directly.
  const token = mintToken({
    aud: "vellum-gateway",
    sub: proxyGrantSubject(provider, pinnedAccount ?? undefined),
    scope_profile: "oauth_proxy_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds,
  });

  const path = `/v1/oauth/proxy/${segment}`;
  const baseUrl = `${getGatewayInternalBaseUrl().replace(/\/+$/, "")}${path}`;

  log.info(
    { provider, account: pinnedAccount, ttlSeconds },
    "OAuth proxy grant minted",
  );

  return {
    ok: true,
    provider,
    account: pinnedAccount,
    baseUrl,
    path,
    token,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "oauth_proxy_grant",
    endpoint: "oauth/proxy-grant",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Mint an OAuth proxy grant",
    description:
      "Returns a short-lived token and base URL a third-party CLI uses to call the provider's API through the passthrough proxy.",
    tags: ["oauth"],
    requestBody: GrantRequestSchema,
    responseBody: GrantResponseSchema,
    additionalResponses: {
      "400": { description: "Malformed request, provider key, or account" },
      "404": { description: "Unknown provider" },
      "409": {
        description: "Several accounts are connected and none was pinned",
      },
      "424": { description: "No usable connection; reconnect the provider" },
    },
    handler: handleOAuthProxyGrant,
  },
];
