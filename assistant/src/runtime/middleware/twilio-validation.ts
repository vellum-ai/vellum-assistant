/**
 * Twilio webhook signature validation and related constants.
 */

import { TwilioConversationRelayProvider } from "../../calls/twilio-provider.js";
import { isTwilioWebhookValidationDisabled } from "../../config/env.js";
import { loadConfig } from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";

const log = getLogger("runtime-http");

/**
 * Regex to extract the Twilio webhook subpath:
 *   /v1/calls/twilio/<subpath>
 */
export const TWILIO_WEBHOOK_RE = /^\/v1\/calls\/twilio\/(.+)$/;

/**
 * Gateway-compatible Twilio webhook paths:
 *   /webhooks/twilio/<subpath>
 *
 * Maps gateway path segments to the internal subpath names used by the
 * dispatcher below (e.g. "voice" -> "voice-webhook").
 */
export const TWILIO_GATEWAY_WEBHOOK_RE = /^\/webhooks\/twilio\/(.+)$/;
export const GATEWAY_SUBPATH_MAP: Record<string, string> = {
  voice: "voice-webhook",
  status: "status",
  "connect-action": "connect-action",
  sms: "sms",
};

/**
 * Direct Twilio webhook subpaths that are blocked in gateway_only mode.
 * Includes all public-facing webhook paths (voice, status, connect-action, sms)
 * because the runtime must never serve as a direct ingress for external webhooks.
 * Internal forwarding endpoints (gateway->runtime) are unaffected.
 */
export const GATEWAY_ONLY_BLOCKED_SUBPATHS = new Set([
  "voice-webhook",
  "status",
  "connect-action",
  "sms",
]);

/**
 * Validate a Twilio webhook request's X-Twilio-Signature header.
 *
 * Returns the raw body text on success so callers can reconstruct the Request
 * for downstream handlers (which also need to read the body).
 * Returns a 403 Response if signature validation fails.
 *
 * Fail-closed: if the auth token is not configured, the request is rejected
 * with 403 rather than silently skipping validation. An explicit local-dev
 * bypass is available via TWILIO_WEBHOOK_VALIDATION_DISABLED=true.
 */
export async function validateTwilioWebhook(
  req: Request,
): Promise<{ body: string } | Response> {
  const rawBody = await req.text();

  // Allow explicit local-dev bypass -- must be exactly "true"
  if (isTwilioWebhookValidationDisabled()) {
    log.warn(
      "Twilio webhook signature validation explicitly disabled via TWILIO_WEBHOOK_VALIDATION_DISABLED",
    );
    return { body: rawBody };
  }

  const authToken = TwilioConversationRelayProvider.getAuthToken();

  if (!authToken) {
    log.error(
      "Twilio auth token not found in credential store — cannot verify webhook HMAC signature. " +
        "Rejecting request. Store auth token via credential store (twilio:auth_token).",
    );
    return httpError("FORBIDDEN", "Forbidden", 403);
  }

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) {
    log.warn("Twilio webhook request missing X-Twilio-Signature header");
    return httpError("FORBIDDEN", "Forbidden", 403);
  }

  // Parse form-urlencoded body into key-value params for signature computation
  const params: Record<string, string> = {};
  const formData = new URLSearchParams(rawBody);
  for (const [key, value] of formData.entries()) {
    params[key] = value;
  }

  // Reconstruct the public-facing URL that Twilio signed against.
  // Behind proxies/gateways, req.url is the local runtime URL which
  // differs from the public URL Twilio used to compute the HMAC-SHA1
  // signature.
  let publicBaseUrl: string | undefined;
  try {
    publicBaseUrl = getPublicBaseUrl(loadConfig());
  } catch {
    // No webhook base URL configured -- fall back to using req.url as-is
  }
  const parsedUrl = new URL(req.url);
  const publicUrl = publicBaseUrl
    ? publicBaseUrl + parsedUrl.pathname + parsedUrl.search
    : req.url;

  const isValid = TwilioConversationRelayProvider.verifyWebhookSignature(
    publicUrl,
    params,
    signature,
    authToken,
  );

  if (!isValid) {
    log.warn("Twilio webhook signature validation failed");
    return httpError("FORBIDDEN", "Forbidden", 403);
  }

  return { body: rawBody };
}

/**
 * Re-create a Request with the same method, headers, and URL but with a
 * pre-read body string so downstream handlers can call req.text() again.
 */
export function cloneRequestWithBody(original: Request, body: string): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body,
  });
}
