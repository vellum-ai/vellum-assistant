/**
 * Remote-web pairing for the SPA served by nginx ingress.
 *
 * The CLI creates a short-lived code over direct loopback after the tunnel URL
 * is known. The remote browser submits that code through nginx; on success the
 * gateway sets an HttpOnly session cookie containing a normal gateway-audience
 * edge JWT. JavaScript never receives the token.
 */

import { createHash, randomInt } from "node:crypto";

import { resolveLocalGuardianPrincipalId } from "./pair.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken } from "../../auth/token-service.js";
import { getLogger } from "../../logger.js";
import { requestArrivedViaEdgeProxy } from "../edge-forwarded-header.js";
import { enforceLoopbackOnly, errorResponse } from "../loopback-guard.js";
import { serializeRemoteWebSessionCookie } from "../remote-web-session-cookie.js";

const log = getLogger("remote-web-pairing");

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CODE_DIGITS = 6;
const PAIR_ATTEMPT_WINDOW_MS = 60_000;
const PAIR_ATTEMPT_MAX = 20;

const DAEMON_INTERNAL_ASSISTANT_ID = "self";

interface PendingPairingCode {
  publicOrigin: string;
  expiresAtMs: number;
}

const pendingCodes = new Map<string, PendingPairingCode>();
let pairAttemptTimestamps: number[] = [];
let nowForTests: (() => number) | null = null;

function getExternalAssistantId(): string {
  return (
    process.env.VELLUM_ASSISTANT_NAME?.trim() || DAEMON_INTERNAL_ASSISTANT_ID
  );
}

function nowMs(): number {
  return nowForTests?.() ?? Date.now();
}

function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^0-9]/g, "");
  return normalized.length === CODE_DIGITS ? normalized : null;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function generateCode(): { raw: string; display: string; hash: string } {
  const raw = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(
    CODE_DIGITS,
    "0",
  );
  return { raw, display: formatCode(raw), hash: hashCode(raw) };
}

function cleanupExpiredCodes(): void {
  const now = nowMs();
  for (const [hash, record] of pendingCodes) {
    if (record.expiresAtMs <= now) pendingCodes.delete(hash);
  }
}

function checkPairAttemptRateLimit(): {
  allowed: boolean;
  resetAt: number;
} {
  const now = nowMs();
  const windowStart = now - PAIR_ATTEMPT_WINDOW_MS;
  pairAttemptTimestamps = pairAttemptTimestamps.filter((t) => t > windowStart);

  if (pairAttemptTimestamps.length >= PAIR_ATTEMPT_MAX) {
    const oldest = pairAttemptTimestamps[0] ?? now;
    return {
      allowed: false,
      resetAt: Math.ceil((oldest + PAIR_ATTEMPT_WINDOW_MS) / 1000),
    };
  }

  pairAttemptTimestamps.push(now);
  return {
    allowed: true,
    resetAt: Math.ceil((now + PAIR_ATTEMPT_WINDOW_MS) / 1000),
  };
}

function parsePublicOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.host) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostMatchesOrigin(req: Request, publicOrigin: string): boolean {
  const host = req.headers.get("host")?.toLowerCase();
  if (!host) return false;
  return host === new URL(publicOrigin).host.toLowerCase();
}

function originMatches(req: Request, publicOrigin: string): boolean {
  return req.headers.get("origin") === publicOrigin;
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function resetRemoteWebPairingForTests(): void {
  pendingCodes.clear();
  pairAttemptTimestamps = [];
  nowForTests = null;
}

export function setRemoteWebPairingNowForTests(now: () => number): void {
  nowForTests = now;
}

export async function handleCreateRemoteWebPairingCode(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const guardError = enforceLoopbackOnly(
    req,
    clientIp,
    "remote-web-pairing-code",
  );
  if (guardError) return guardError;

  let publicOrigin: string | null = null;
  try {
    const body = (await req.json()) as { publicBaseUrl?: unknown };
    publicOrigin = parsePublicOrigin(body.publicBaseUrl);
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!publicOrigin) {
    return jsonError("BAD_REQUEST", "publicBaseUrl is required", 400);
  }

  cleanupExpiredCodes();

  let code = generateCode();
  while (pendingCodes.has(code.hash)) {
    code = generateCode();
  }

  const expiresAtMs = nowMs() + CODE_TTL_MS;
  pendingCodes.set(code.hash, {
    publicOrigin,
    expiresAtMs,
  });

  log.info(
    { publicOrigin, expiresAt: new Date(expiresAtMs).toISOString() },
    "Remote web pairing code created",
  );

  return Response.json(
    {
      code: code.display,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresInSeconds: Math.ceil(CODE_TTL_MS / 1000),
      publicOrigin,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleRemoteWebPair(
  req: Request,
  _clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  if (!requestArrivedViaEdgeProxy(req)) {
    return errorResponse("FORBIDDEN", "endpoint is remote-web only", 403);
  }

  const rateLimit = checkPairAttemptRateLimit();
  if (!rateLimit.allowed) {
    const retryAfter = Math.max(
      1,
      rateLimit.resetAt - Math.ceil(nowMs() / 1000),
    );
    return Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "too many remote web pairing attempts",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(PAIR_ATTEMPT_MAX),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rateLimit.resetAt),
        },
      },
    );
  }

  let code: string | null = null;
  try {
    const body = (await req.json()) as { code?: unknown };
    code = normalizeCode(body.code);
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!code) {
    return jsonError("BAD_REQUEST", "code is required", 400);
  }

  cleanupExpiredCodes();

  const codeHash = hashCode(code);
  const pending = pendingCodes.get(codeHash);
  if (!pending) {
    return jsonError("INVALID_PAIRING_CODE", "invalid pairing code", 401);
  }

  if (
    !originMatches(req, pending.publicOrigin) ||
    !hostMatchesOrigin(req, pending.publicOrigin)
  ) {
    log.warn(
      {
        expectedOrigin: pending.publicOrigin,
        origin: req.headers.get("origin"),
        host: req.headers.get("host"),
      },
      "Remote web pairing rejected: origin or host mismatch",
    );
    return errorResponse("FORBIDDEN", "origin mismatch", 403);
  }

  pendingCodes.delete(codeHash);

  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  const assistantId = getExternalAssistantId();
  const token = mintToken({
    aud: "vellum-gateway",
    sub: `actor:${assistantId}:${guardianPrincipalId}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  const expiresAt = new Date(nowMs() + SESSION_TTL_SECONDS * 1000);

  log.info(
    { publicOrigin: pending.publicOrigin, expiresAt: expiresAt.toISOString() },
    "Remote web paired successfully",
  );

  return Response.json(
    {
      ok: true,
      assistantId,
      expiresAt: expiresAt.toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": serializeRemoteWebSessionCookie({
          token,
          maxAgeSeconds: SESSION_TTL_SECONDS,
        }),
      },
    },
  );
}
