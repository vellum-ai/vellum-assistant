import { verifyTwilioSignature } from "@vellumai/vellum-gateway/twilio/verify";

import type {
  ManagedGatewayConfig,
  ManagedGatewayTwilioAuthTokenMetadata,
} from "./config.js";

export { computeTwilioSignature } from "@vellumai/vellum-gateway/twilio/verify";

export type ManagedGatewayTwilioSignatureValidationResult =
  | {
    ok: true;
    tokenId: string;
  }
  | {
    ok: false;
    code: "missing_signature" | "no_active_tokens" | "invalid_signature";
    detail: string;
  };

export function validateManagedTwilioSignature(
  config: ManagedGatewayConfig,
  args: {
    url: string | string[];
    params: Record<string, string>;
    signature: string | null | undefined;
    nowMs?: number;
  },
): ManagedGatewayTwilioSignatureValidationResult {
  const signature = args.signature?.trim() || "";
  if (!signature) {
    return {
      ok: false,
      code: "missing_signature",
      detail: "Missing X-Twilio-Signature header.",
    };
  }

  const activeTokens = getActiveTwilioAuthTokens(config, args.nowMs);
  if (activeTokens.length === 0) {
    return {
      ok: false,
      code: "no_active_tokens",
      detail: "No active Twilio auth tokens are configured.",
    };
  }

  const urls = Array.isArray(args.url) ? args.url : [args.url];

  for (const url of urls) {
    for (const token of activeTokens) {
      if (verifyTwilioSignature(
        url,
        args.params,
        signature,
        token.authToken,
      )) {
        return {
          ok: true,
          tokenId: token.tokenId,
        };
      }
    }
  }

  return {
    ok: false,
    code: "invalid_signature",
    detail: "Invalid Twilio request signature.",
  };
}

function firstHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * Build URL candidates Twilio may have used when computing the webhook signature.
 * TLS termination before the managed gateway means Twilio signs the external
 * https:// URL but the gateway sees an internal http:// URL.
 *
 * Precedence:
 * 1) Forwarded public URL from proxy/load-balancer headers
 * 2) Raw request URL (last-resort fallback)
 */
export function buildManagedSignatureUrlCandidates(req: Request): string[] {
  const parsedUrl = new URL(req.url);
  const pathAndQuery = parsedUrl.pathname + parsedUrl.search;
  const candidates: string[] = [];

  const addBase = (base: string | undefined): void => {
    if (!base) return;
    const normalized = base.trim().replace(/\/+$/, "");
    if (!normalized) return;
    const candidate = `${normalized}${pathAndQuery}`;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  const forwardedProto =
    firstHeaderValue(req.headers.get("x-forwarded-proto")) ??
    firstHeaderValue(req.headers.get("x-original-proto"));
  const forwardedHost =
    firstHeaderValue(req.headers.get("x-forwarded-host")) ??
    firstHeaderValue(req.headers.get("x-original-host"));
  if (forwardedProto && forwardedHost) {
    addBase(`${forwardedProto}://${forwardedHost}`);
  }

  if (!candidates.includes(req.url)) {
    candidates.push(req.url);
  }

  return candidates;
}

function getActiveTwilioAuthTokens(
  config: ManagedGatewayConfig,
  nowMs: number = Date.now(),
): ManagedGatewayTwilioAuthTokenMetadata[] {
  const active: ManagedGatewayTwilioAuthTokenMetadata[] = [];

  for (const token of Object.values(config.twilio.authTokens)) {
    if (token.revoked || config.twilio.revokedTokenIds.has(token.tokenId)) {
      continue;
    }

    if (token.expiresAt) {
      const expiresAtMs = Date.parse(token.expiresAt);
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
        continue;
      }
    }

    active.push(token);
  }

  return active;
}
