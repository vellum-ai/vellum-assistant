import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  ManagedGatewayConfig,
  ManagedGatewayTwilioAuthTokenMetadata,
} from "./config.js";

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

export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  return createHmac("sha1", authToken)
    .update(data)
    .digest("base64");
}

export function verifyTwilioSignatureWithAuthToken(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  const computed = computeTwilioSignature(url, params, authToken);
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function validateManagedTwilioSignature(
  config: ManagedGatewayConfig,
  args: {
    url: string;
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

  for (const token of activeTokens) {
    if (verifyTwilioSignatureWithAuthToken(
      args.url,
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

  return {
    ok: false,
    code: "invalid_signature",
    detail: "Invalid Twilio request signature.",
  };
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
