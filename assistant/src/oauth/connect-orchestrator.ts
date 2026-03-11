/**
 * Shared OAuth connect orchestrator.
 *
 * Encapsulates the full OAuth2 authorization code flow (interactive and
 * deferred paths) so that both the credential vault tool and future
 * callers can connect OAuth services without duplicating orchestration
 * logic.
 *
 * The caller is responsible for:
 * - Resolving client_id / client_secret (from user input or the vault)
 * - Early validation (missing service, missing client_id, requiresSecret)
 * - Ensuring metadata is writable (assertMetadataWritable)
 *
 * The orchestrator handles:
 * - Provider profile resolution
 * - Scope policy enforcement
 * - Building the OAuth2Config
 * - Running the interactive or deferred flow
 * - Storing tokens on completion
 * - Running identity verifiers
 */

import type { TokenEndpointAuthMethod } from "../security/oauth2.js";
import { prepareOAuth2Flow, startOAuth2Flow } from "../security/oauth2.js";
import { getLogger } from "../util/logger.js";
import type { OAuthConnectResult } from "./connect-types.js";
import { getProviderProfile, resolveService } from "./provider-profiles.js";
import { resolveScopes } from "./scope-policy.js";
import { storeOAuth2Tokens } from "./token-persistence.js";

const log = getLogger("oauth-connect-orchestrator");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OAuthConnectOptions {
  /** Raw service name (may be an alias like "gmail"). */
  service: string;
  /** Scopes to request beyond the provider's defaults. */
  requestedScopes?: string[];
  /** OAuth2 client ID (required). */
  clientId: string;
  /** OAuth2 client secret (optional — PKCE-only when absent). */
  clientSecret?: string;
  /** Whether the session can open a browser and block for completion. */
  isInteractive: boolean;
  /** Open a URL in the user's browser (interactive path). */
  openUrl?: (url: string) => void;
  /** Send a message to the client (e.g. open_url). */
  sendToClient?: (msg: { type: string; [key: string]: unknown }) => void;
  /** Tools allowed to use the resulting credential. */
  allowedTools?: string[];

  // Optional overrides — when provided, these take precedence over the
  // provider profile. This lets callers connect custom / unknown providers.
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  extraParams?: Record<string, string>;
  userinfoUrl?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Orchestrate an OAuth2 connect flow end to end.
 *
 * Returns a discriminated result:
 * - Interactive success: `{ success: true, deferred: false, grantedScopes, accountInfo }`
 * - Deferred success:    `{ success: true, deferred: true, authUrl, state, service }`
 * - Error:               `{ success: false, error }`
 */
export async function orchestrateOAuthConnect(
  options: OAuthConnectOptions,
): Promise<OAuthConnectResult> {
  const resolvedService = resolveService(options.service);
  const profile = getProviderProfile(resolvedService);

  // Merge explicit overrides with profile defaults
  const authUrl = options.authUrl ?? profile?.authUrl;
  const tokenUrl = options.tokenUrl ?? profile?.tokenUrl;
  const extraParams = options.extraParams ?? profile?.extraParams;
  const userinfoUrl = options.userinfoUrl ?? profile?.userinfoUrl;
  const tokenEndpointAuthMethod =
    options.tokenEndpointAuthMethod ?? profile?.tokenEndpointAuthMethod;

  // Scopes: use explicit override, then try scope policy resolution, then profile defaults
  let finalScopes: string[];
  if (options.scopes) {
    // Explicit scopes override — bypass policy (caller takes responsibility)
    finalScopes = options.scopes;
  } else if (profile) {
    const scopeResult = resolveScopes(profile, options.requestedScopes);
    if (!scopeResult.ok) {
      const guidance = scopeResult.allowedScopes
        ? ` Allowed scopes: ${scopeResult.allowedScopes.join(", ")}`
        : "";
      return {
        success: false,
        error: `${scopeResult.error}${guidance}`,
        safeError: true,
      };
    }
    finalScopes = scopeResult.scopes;
  } else {
    // No profile and no explicit scopes — cannot proceed
    return {
      success: false,
      error: `No well-known OAuth config found for "${options.service}" and no scopes were provided`,
      safeError: true,
    };
  }

  if (!authUrl) {
    return {
      success: false,
      error: "auth_url is required (no well-known config for this service)",
      safeError: true,
    };
  }
  if (!tokenUrl) {
    return {
      success: false,
      error: "token_url is required (no well-known config for this service)",
      safeError: true,
    };
  }

  const oauthConfig = {
    authUrl,
    tokenUrl,
    scopes: finalScopes,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    extraParams,
    userinfoUrl,
    tokenEndpointAuthMethod,
  };

  const storageParams = {
    service: resolvedService,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    tokenUrl,
    tokenEndpointAuthMethod,
    userinfoUrl,
    allowedTools: options.allowedTools,
    wellKnownInjectionTemplates: profile?.injectionTemplates,
  };

  // -----------------------------------------------------------------------
  // Deferred (non-interactive) path
  // -----------------------------------------------------------------------
  if (!options.isInteractive) {
    try {
      const callbackTransport = profile?.callbackTransport ?? "gateway";

      // Gateway transport needs a public ingress URL
      if (callbackTransport !== "loopback") {
        const { loadConfig } = await import("../config/loader.js");
        const { getPublicBaseUrl } =
          await import("../inbound/public-ingress-urls.js");
        try {
          getPublicBaseUrl(loadConfig());
        } catch {
          return {
            success: false,
            error:
              "oauth2_connect from a non-interactive session requires a public ingress URL. Configure ingress.publicBaseUrl first.",
            safeError: true,
          };
        }
      }

      const prepared = await prepareOAuth2Flow(
        oauthConfig,
        callbackTransport === "loopback"
          ? { callbackTransport, loopbackPort: profile?.loopbackPort }
          : undefined,
      );

      // Fire-and-forget: store tokens when the callback arrives
      prepared.completion
        .then(async (result) => {
          try {
            let accountInfo: string | undefined;

            // Run identity verifier if available
            if (profile?.identityVerifier) {
              try {
                accountInfo = await profile.identityVerifier(
                  result.tokens.accessToken,
                );
              } catch {
                // Non-fatal
              }
            }

            const stored = await storeOAuth2Tokens({
              ...storageParams,
              tokens: result.tokens,
              grantedScopes: result.grantedScopes,
              rawTokenResponse: result.rawTokenResponse,
              identityAccountInfo: accountInfo,
            });
            log.info(
              {
                service: resolvedService,
                accountInfo: stored.accountInfo ?? accountInfo,
              },
              "Deferred OAuth2 flow completed — tokens stored",
            );
          } catch (err) {
            log.error(
              { err, service: resolvedService },
              "Failed to store tokens from deferred OAuth2 flow",
            );
          }
        })
        .catch((err) => {
          log.error(
            { err, service: resolvedService },
            "Deferred OAuth2 flow failed",
          );
        });

      return {
        success: true,
        deferred: true,
        authUrl: prepared.authUrl,
        state: prepared.state,
        service: resolvedService,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Unknown error preparing OAuth flow";
      return {
        success: false,
        error: `Error connecting "${resolvedService}": ${message}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Interactive path — open browser, block until completion
  // -----------------------------------------------------------------------
  try {
    const { tokens, grantedScopes, rawTokenResponse } = await startOAuth2Flow(
      oauthConfig,
      {
        openUrl: (url) => {
          if (options.openUrl) {
            options.openUrl(url);
          } else if (options.sendToClient) {
            options.sendToClient({
              type: "open_url",
              url,
              title: `Connect ${resolvedService}`,
            });
          }
        },
      },
      profile?.callbackTransport
        ? {
            callbackTransport: profile.callbackTransport,
            loopbackPort: profile.loopbackPort,
          }
        : undefined,
    );

    // Run identity verifier if available
    let verifiedIdentity: string | undefined;
    if (profile?.identityVerifier) {
      try {
        verifiedIdentity = await profile.identityVerifier(tokens.accessToken);
      } catch {
        // Non-fatal
      }
    }

    const { accountInfo } = await storeOAuth2Tokens({
      ...storageParams,
      tokens,
      grantedScopes,
      rawTokenResponse,
      identityAccountInfo: verifiedIdentity,
    });

    return {
      success: true,
      deferred: false,
      grantedScopes,
      accountInfo: accountInfo ?? verifiedIdentity,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during OAuth flow";
    return {
      success: false,
      error: `Error connecting "${resolvedService}": ${message}`,
    };
  }
}
