/**
 * Token exchange module for the gateway's auth system.
 *
 * The gateway receives edge tokens (aud=vellum-gateway) from external clients
 * and mints short-lived exchange tokens (aud=vellum-daemon) for forwarding
 * to the runtime. This exchange proves gateway origin — only the gateway
 * holds the signing key needed to mint daemon-audience tokens.
 *
 * Exchange tokens have a 60-second TTL and rewrite the sub claim's assistant
 * segment to 'self' (the daemon's internal scope constant).
 */

import { getLogger } from "../logger.js";

import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { parseSub } from "./subject.js";
import { mintToken, verifyToken, type VerifyResult } from "./token-service.js";
import type { ScopeProfile, TokenClaims } from "./types.js";

const log = getLogger("token-exchange");

/** TTL for exchange tokens — short-lived, minted per-request. */
const EXCHANGE_TOKEN_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// Edge token validation
// ---------------------------------------------------------------------------

/**
 * Validate a JWT edge token intended for the gateway (aud=vellum-gateway).
 *
 * Returns the verified claims on success, or a structured error on failure.
 * Pass `allowExpired: true` to accept expired-but-otherwise-valid tokens
 * (signature, audience, and policy epoch are still checked). This is used
 * by the refresh endpoint so clients can obtain new credentials even after
 * the access token has expired.
 */
export function validateEdgeToken(
  token: string,
  opts?: { allowExpired?: boolean },
): VerifyResult {
  return verifyToken(token, "vellum-gateway", opts);
}

// ---------------------------------------------------------------------------
// Exchange token minting
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived exchange token (aud=vellum-daemon) from validated
 * edge claims. The sub claim's assistant segment is rewritten to 'self'
 * so the daemon always uses its internal scope constant.
 */
export function mintExchangeToken(
  edgeClaims: TokenClaims,
  targetScopeProfile: ScopeProfile,
): string {
  const parsed = parseSub(edgeClaims.sub);
  let exchangeSub: string;

  if (!parsed.ok) {
    // If sub parsing fails, log and use a gateway service sub as fallback
    log.warn(
      { sub: edgeClaims.sub, reason: parsed.reason },
      "Failed to parse edge token sub, using gateway service sub",
    );
    exchangeSub = "svc:gateway:self";
  } else {
    // Rewrite the assistant segment to 'self'
    switch (parsed.principalType) {
      case "actor":
        exchangeSub = `actor:self:${parsed.actorPrincipalId}`;
        break;
      case "svc_gateway":
        exchangeSub = "svc:gateway:self";
        break;
      case "local":
        exchangeSub = `local:self:${parsed.conversationId}`;
        break;
      default:
        exchangeSub = "svc:gateway:self";
    }
  }

  return mintToken({
    aud: "vellum-daemon",
    sub: exchangeSub,
    scope_profile: targetScopeProfile,
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Gateway-minted service tokens
// ---------------------------------------------------------------------------

/**
 * Mint an ingress exchange token for webhook handlers.
 * Used after platform signature validation (Telegram, Twilio, WhatsApp, Slack)
 * to forward authenticated inbound events to the runtime.
 *
 * sub=svc:gateway:self, scope_profile=gateway_ingress_v1
 */
export function mintIngressToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

/**
 * Mint a service token for gateway-to-runtime service calls.
 * Used for delivery endpoints, control-plane proxies, and other
 * gateway-originated requests to the daemon.
 *
 * sub=svc:gateway:self, scope_profile=gateway_service_v1
 */
export function mintServiceToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

/**
/**
 * Mint a relay token for Twilio WebSocket connections.
 *
 * The gateway's relay/media-stream WS handlers validate these tokens via
 * {@link validateEdgeToken} (aud=vellum-gateway). Previously minted by the
 * daemon and embedded in TwiML; now minted by the gateway and injected into
 * the TwiML response before it reaches Twilio.
 *
 * sub=svc:gateway:self, scope_profile=gateway_service_v1
 */
export function mintRelayToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

/**
 * Mint a JWT for embedding in browser-served UI pages (brain-graph).
 *
 * The daemon returns HTML containing a placeholder; the gateway replaces it
 * with this token before serving the page. Uses the ui_page_v1 scope profile
 * which grants only settings.read — the minimum needed for the brain-graph
 * data endpoint. 1-hour TTL gives users time to interact with the page.
 */
export function mintUiPageToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "ui_page_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}
