import { createHash, randomBytes, randomInt } from "node:crypto";

import { enforceLoopbackOnly } from "../loopback-guard.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;
const POLL_INTERVAL_SECONDS = 5;

interface PendingRemoteWebPairingChallenge {
  deviceCodeHash: string;
  userCodeHash: string;
  publicOrigin: string;
  verificationUri: string;
  expiresAtMs: number;
}

const challengesByUserCodeHash = new Map<
  string,
  PendingRemoteWebPairingChallenge
>();
let nowForTests: (() => number) | null = null;

function nowMs(): number {
  return nowForTests?.() ?? Date.now();
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function randomUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function cleanupExpiredChallenges(): void {
  const now = nowMs();
  for (const [hash, challenge] of challengesByUserCodeHash) {
    if (challenge.expiresAtMs <= now) challengesByUserCodeHash.delete(hash);
  }
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function resetRemoteWebPairingChallengesForTests(): void {
  challengesByUserCodeHash.clear();
  nowForTests = null;
}

export function setRemoteWebPairingChallengeNowForTests(
  now: () => number,
): void {
  nowForTests = now;
}

export function getRemoteWebPairingChallengeForTests(
  userCode: string,
): PendingRemoteWebPairingChallenge | undefined {
  return challengesByUserCodeHash.get(hashSecret(normalizeUserCode(userCode)));
}

export async function handleCreateRemoteWebPairingChallenge(
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
    "remote-web-pairing-challenge",
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

  cleanupExpiredChallenges();

  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("base64url");
  let userCode = randomUserCode();
  let userCodeHash = hashSecret(normalizeUserCode(userCode));
  while (challengesByUserCodeHash.has(userCodeHash)) {
    userCode = randomUserCode();
    userCodeHash = hashSecret(normalizeUserCode(userCode));
  }

  const verificationUri = new URL("/assistant/pair", publicOrigin).toString();
  const expiresAtMs = nowMs() + CODE_TTL_MS;
  challengesByUserCodeHash.set(userCodeHash, {
    deviceCodeHash: hashSecret(deviceCode),
    userCodeHash,
    publicOrigin,
    verificationUri,
    expiresAtMs,
  });

  return Response.json(
    {
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresInSeconds: Math.ceil(CODE_TTL_MS / 1000),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
