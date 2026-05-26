import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { mintToken, verifyToken, type VerifyResult } from "./token-service.js";

const SESSION_COOKIE_NAME = "__vellum_gw_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function mintSessionCookie(params: {
  guardianPrincipalId: string;
  secure?: boolean;
}): string {
  const token = mintToken({
    aud: "vellum-gateway-session",
    sub: `actor:self:${params.guardianPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: SESSION_TTL_SECONDS,
  });

  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (params.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function validateSessionCookie(req: Request): VerifyResult {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) {
    return { ok: false, reason: "no_cookie_header" };
  }

  let token: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      token = trimmed.slice(SESSION_COOKIE_NAME.length + 1);
      break;
    }
  }

  if (!token) {
    return { ok: false, reason: "session_cookie_not_found" };
  }

  return verifyToken(token, "vellum-gateway-session");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
