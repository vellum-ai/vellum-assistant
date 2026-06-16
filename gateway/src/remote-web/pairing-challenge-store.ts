import { createHash, randomBytes, randomInt } from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;
const POLL_INTERVAL_SECONDS = 5;

export interface PendingRemoteWebPairingChallenge {
  deviceCodeHash: string;
  userCodeHash: string;
  publicBaseUrl: string;
  verificationUri: string;
  status: "pending" | "approved";
  expiresAtMs: number;
  approvedAtMs?: number;
}

export interface CreatedRemoteWebPairingChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type ApproveRemoteWebPairingChallengeResult =
  | {
      status: "approved";
      verificationUri: string;
      expiresAt: string;
    }
  | { status: "expired" }
  | { status: "invalid" };

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

export function createRemoteWebPairingChallenge(
  publicBaseUrl: string,
): CreatedRemoteWebPairingChallenge {
  cleanupExpiredChallenges();

  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("base64url");
  let userCode = randomUserCode();
  let userCodeHash = hashSecret(normalizeUserCode(userCode));
  while (challengesByUserCodeHash.has(userCodeHash)) {
    userCode = randomUserCode();
    userCodeHash = hashSecret(normalizeUserCode(userCode));
  }

  const verificationUri = `${publicBaseUrl}/assistant/pair`;
  const expiresAtMs = nowMs() + CODE_TTL_MS;
  challengesByUserCodeHash.set(userCodeHash, {
    deviceCodeHash: hashSecret(deviceCode),
    userCodeHash,
    publicBaseUrl,
    verificationUri,
    status: "pending",
    expiresAtMs,
  });

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.ceil(CODE_TTL_MS / 1000),
    intervalSeconds: POLL_INTERVAL_SECONDS,
  };
}

export function approveRemoteWebPairingChallenge(
  userCode: string,
): ApproveRemoteWebPairingChallengeResult {
  const userCodeHash = hashSecret(normalizeUserCode(userCode));
  const challenge = challengesByUserCodeHash.get(userCodeHash);
  if (!challenge) return { status: "invalid" };

  const now = nowMs();
  if (challenge.expiresAtMs <= now) {
    challengesByUserCodeHash.delete(userCodeHash);
    return { status: "expired" };
  }

  challenge.status = "approved";
  challenge.approvedAtMs = now;
  return {
    status: "approved",
    verificationUri: challenge.verificationUri,
    expiresAt: new Date(challenge.expiresAtMs).toISOString(),
  };
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
