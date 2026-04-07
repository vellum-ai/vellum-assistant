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
 * - Provider config resolution (from DB)
 * - Scope policy enforcement
 * - Building the OAuth2Config
 * - Running the interactive or deferred flow
 * - Storing tokens on completion
 * - Running identity verifiers
 */

import type { TokenEndpointAuthMethod } from "../security/oauth2.js";
import { prepareOAuth2Flow, startOAuth2Flow } from "../security/oauth2.js";
import { getLogger } from "../util/logger.js";
import type { OAuthConnectResult, OAuthScopePolicy } from "./connect-types.js";
import { verifyIdentity } from "./identity-verifier.js";
import { getProvider } from "./oauth-store.js";
import { resolveScopes } from "./scope-policy.js";
import { storeOAuth2Tokens } from "./token-persistence.js";

const log = getLogger("oauth-connect-orchestrator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely parse a JSON string, returning a fallback on failure or null/undefined input. */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OAuthConnectOptions {
  /** Canonical service name (e.g. "google", "slack"). */
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

  /**
   * Callback transport to use for the OAuth redirect.
   * - `"loopback"` — start a local HTTP server (desktop clients).
   * - `"gateway"` — use the public gateway ingress (web clients).
   * Defaults to `"loopback"` when omitted.
   */
  callbackTransport?: "loopback" | "gateway";

  /**
   * Called when the deferred (non-interactive) flow completes — either
   * successfully after tokens are stored, or on failure. Lets callers
   * surface the outcome via SSE events, logs, etc.
   */
  onDeferredComplete?: (result: {
    success: boolean;
    service: string;
    accountInfo?: string;
    error?: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Orchestrate an OAuth2 connect flow end to end.
 *
 * Returns a discriminated result:
 * - Interactive success: `{ success: true, deferred: false, grantedScopes, accountInfo }`
 * - Deferred success:    `{ success: true, deferred: true, authorizeUrl, state, service }`
 * - Error:               `{ success: false, error }`
 */
export async function orchestrateOAuthConnect(
  options: OAuthConnectOptions,
): Promise<OAuthConnectResult> {
  log.info(
    {
      service: options.service,
      isInteractive: options.isInteractive,
      hasOpenUrl: !!options.openUrl,
      hasSendToClient: !!options.sendToClient,
    },
    "orchestrateOAuthConnect: starting",
  );

  // Read provider config from the DB
  const providerRow = getProvider(options.service);
  if (!providerRow) {
    return {
      success: false,
      error: `No OAuth provider registered for "${options.service}". Ensure the provider is seeded in the database.`,
      safeError: true,
    };
  }

  // Deserialize JSON fields from the DB row
  const dbDefaultScopes = safeJsonParse<string[]>(
    providerRow.defaultScopes,
    [],
  );
  const dbScopePolicy = safeJsonParse<OAuthScopePolicy>(
    providerRow.scopePolicy,
    {
      allowAdditionalScopes: false,
      allowedOptionalScopes: [],
      forbiddenScopes: [],
    },
  );
  const dbAuthorizeParams = safeJsonParse<Record<string, string> | undefined>(
    providerRow.authorizeParams,
    undefined,
  );

  // Resolve all protocol-level config from the DB
  const authorizeUrl = providerRow.authorizeUrl;
  const tokenExchangeUrl = providerRow.tokenExchangeUrl;
  const authorizeParams = dbAuthorizeParams;
  const userinfoUrl = providerRow.userinfoUrl ?? undefined;
  const tokenEndpointAuthMethod = providerRow.tokenEndpointAuthMethod as
    | TokenEndpointAuthMethod
    | undefined;
  const callbackTransport: "loopback" | "gateway" =
    options.callbackTransport ?? "loopback";
  const loopbackPort = providerRow.loopbackPort ?? undefined;

  // Resolve scopes via the scope policy engine
  const scopeProfile = {
    service: options.service,
    defaultScopes: dbDefaultScopes,
    scopePolicy: dbScopePolicy,
  };
  const scopeResult = resolveScopes(scopeProfile, options.requestedScopes);
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
  const finalScopes = scopeResult.scopes;

  if (!authorizeUrl) {
    return {
      success: false,
      error: "auth_url is required (no well-known config for this service)",
      safeError: true,
    };
  }
  if (!tokenExchangeUrl) {
    return {
      success: false,
      error: "token_url is required (no well-known config for this service)",
      safeError: true,
    };
  }

  log.info(
    {
      service: options.service,
      authorizeUrl,
      tokenExchangeUrl,
      scopeCount: finalScopes.length,
      callbackTransport,
      loopbackPort,
      hasSecret: !!options.clientSecret,
      clientIdPrefix: options.clientId.substring(0, 12) + "…",
    },
    "orchestrateOAuthConnect: resolved provider config",
  );

  const oauthConfig = {
    authorizeUrl,
    tokenExchangeUrl,
    scopes: finalScopes,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    authorizeParams,
    userinfoUrl,
    tokenEndpointAuthMethod,
  };

  const storageParams = {
    service: options.service,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    userinfoUrl,
  };

  // -----------------------------------------------------------------------
  // Deferred (non-interactive) path
  // -----------------------------------------------------------------------
  if (!options.isInteractive) {
    try {
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
              "OAuth connect from a non-interactive session requires a public ingress URL. Configure ingress.publicBaseUrl first.",
            safeError: true,
          };
        }
      }

      const prepared = await prepareOAuth2Flow(
        oauthConfig,
        callbackTransport === "loopback"
          ? { callbackTransport, loopbackPort }
          : callbackTransport === "gateway"
            ? { callbackTransport }
            : undefined,
      );

      // Fire-and-forget: store tokens when the callback arrives
      prepared.completion
        .then(async (result) => {
          try {
            // Parse account identifier from the provider's identity endpoint.
            // Best-effort — format varies by provider and may fail.
            const parsedAccountIdentifier = await verifyIdentity(
              providerRow,
              result.tokens.accessToken,
            );

            const stored = await storeOAuth2Tokens({
              ...storageParams,
              tokens: result.tokens,
              grantedScopes: result.grantedScopes,
              rawTokenResponse: result.rawTokenResponse,
              parsedAccountIdentifier,
            });
            log.info(
              {
                service: options.service,
                accountInfo: stored.accountInfo ?? parsedAccountIdentifier,
              },
              "Deferred OAuth2 flow completed — tokens stored",
            );
            options.onDeferredComplete?.({
              success: true,
              service: options.service,
              accountInfo: stored.accountInfo ?? parsedAccountIdentifier,
            });
          } catch (err) {
            log.error(
              { err, service: options.service },
              "Failed to store tokens from deferred OAuth2 flow",
            );
            options.onDeferredComplete?.({
              success: false,
              service: options.service,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
        })
        .catch((err) => {
          log.error(
            { err, service: options.service },
            "Deferred OAuth2 flow failed",
          );
          options.onDeferredComplete?.({
            success: false,
            service: options.service,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        });

      return {
        success: true,
        deferred: true,
        authorizeUrl: prepared.authorizeUrl,
        state: prepared.state,
        service: options.service,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Unknown error preparing OAuth flow";
      return {
        success: false,
        error: `Error connecting "${options.service}": ${message}`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Interactive path — open browser, block until completion
  // -----------------------------------------------------------------------
  log.info(
    { service: options.service, callbackTransport, loopbackPort },
    "orchestrateOAuthConnect: entering interactive path",
  );
  try {
    const { tokens, grantedScopes, rawTokenResponse } = await startOAuth2Flow(
      oauthConfig,
      {
        openUrl: (url) => {
          log.info(
            { service: options.service, urlLength: url.length },
            "orchestrateOAuthConnect: openUrl callback fired, delivering auth URL to client",
          );
          if (options.openUrl) {
            log.info("orchestrateOAuthConnect: using options.openUrl");
            options.openUrl(url);
          } else if (options.sendToClient) {
            log.info(
              "orchestrateOAuthConnect: using sendToClient with open_url event",
            );
            options.sendToClient({
              type: "open_url",
              url,
              title: `Connect ${options.service}`,
            });
          } else {
            log.warn(
              "orchestrateOAuthConnect: no openUrl or sendToClient available — auth URL will not reach the user",
            );
          }
        },
      },
      callbackTransport === "loopback"
        ? { callbackTransport, loopbackPort }
        : callbackTransport === "gateway"
          ? { callbackTransport }
          : undefined,
    );

    log.info(
      { service: options.service, grantedScopeCount: grantedScopes.length },
      "orchestrateOAuthConnect: interactive flow completed, exchanged code for tokens",
    );

    // Parse account identifier from the provider's identity endpoint.
    // Best-effort — format varies by provider and may fail.
    const parsedAccountIdentifier = await verifyIdentity(
      providerRow,
      tokens.accessToken,
    );
    if (parsedAccountIdentifier) {
      log.info(
        { service: options.service, parsedAccountIdentifier },
        "orchestrateOAuthConnect: identity verified",
      );
    }

    const { accountInfo } = await storeOAuth2Tokens({
      ...storageParams,
      tokens,
      grantedScopes,
      rawTokenResponse,
      parsedAccountIdentifier,
    });

    log.info(
      { service: options.service, accountInfo },
      "orchestrateOAuthConnect: tokens stored, connect complete",
    );

    return {
      success: true,
      deferred: false,
      grantedScopes,
      accountInfo: accountInfo ?? parsedAccountIdentifier,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error during OAuth flow";
    log.error(
      { service: options.service, err },
      "orchestrateOAuthConnect: interactive flow failed",
    );
    return {
      success: false,
      error: `Error connecting "${options.service}": ${message}`,
    };
  }
}
