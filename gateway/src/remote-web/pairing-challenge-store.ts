import { createHash, randomBytes, randomInt } from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_CHALLENGES = 200;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;
const POLL_INTERVAL_SECONDS = 5;

export interface PendingRemoteWebPairingChallenge {
  deviceCodeHash: string;
  userCodeHash: string;
  publicBaseUrl: string;
  verificationUri: string;
  status: "pending" | "approved" | "exchanging" | "consumed";
  expiresAtMs: number;
  approvedAtMs?: number;
  exchangeStartedAtMs?: number;
  consumedAtMs?: number;
}

export interface CreatedRemoteWebPairingChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface RemoteWebPairingChallengeCapacityLimit {
  retryAfterSeconds: number;
}

export type ApproveRemoteWebPairingChallengeResult =
  | {
      status: "approved";
      verificationUri: string;
      expiresAt: string;
    }
  | { status: "expired" }
  | { status: "invalid" };

export type ClaimRemoteWebPairingChallengeExchangeResult =
  | {
      status: "approved";
      publicBaseUrl: string;
      verificationUri: string;
      expiresAt: string;
    }
  | {
      status: "pending";
      expiresAt: string;
      intervalSeconds: number;
    }
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "invalid" };

const challengesByUserCodeHash = new Map<
  string,
  PendingRemoteWebPairingChallenge
>();
const challengesByDeviceCodeHash = new Map<
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

function cleanupExpiredChallenges(now = nowMs()): void {
  for (const [hash, challenge] of challengesByUserCodeHash) {
    if (challenge.expiresAtMs <= now) {
      challengesByUserCodeHash.delete(hash);
      challengesByDeviceCodeHash.delete(challenge.deviceCodeHash);
    }
  }
}

export function checkRemoteWebPairingChallengeCapacity(): RemoteWebPairingChallengeCapacityLimit | null {
  const now = nowMs();
  cleanupExpiredChallenges(now);

  if (challengesByUserCodeHash.size < MAX_ACTIVE_CHALLENGES) return null;

  let earliestExpiresAtMs = Number.POSITIVE_INFINITY;
  for (const challenge of challengesByUserCodeHash.values()) {
    earliestExpiresAtMs = Math.min(earliestExpiresAtMs, challenge.expiresAtMs);
  }

  return {
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((earliestExpiresAtMs - now) / 1000),
    ),
  };
}

export function createRemoteWebPairingChallenge(
  publicBaseUrl: string,
): CreatedRemoteWebPairingChallenge {
  cleanupExpiredChallenges();

  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("base64url");
  const deviceCodeHash = hashSecret(deviceCode);
  let userCode = randomUserCode();
  let userCodeHash = hashSecret(normalizeUserCode(userCode));
  while (challengesByUserCodeHash.has(userCodeHash)) {
    userCode = randomUserCode();
    userCodeHash = hashSecret(normalizeUserCode(userCode));
  }

  const verificationUri = `${publicBaseUrl}/assistant/pair`;
  const expiresAtMs = nowMs() + CODE_TTL_MS;
  const challenge: PendingRemoteWebPairingChallenge = {
    deviceCodeHash,
    userCodeHash,
    publicBaseUrl,
    verificationUri,
    status: "pending",
    expiresAtMs,
  };
  challengesByUserCodeHash.set(userCodeHash, challenge);
  challengesByDeviceCodeHash.set(deviceCodeHash, challenge);

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
  if (challenge.status === "exchanging" || challenge.status === "consumed") {
    return { status: "invalid" };
  }

  const now = nowMs();
  if (challenge.expiresAtMs <= now) {
    challengesByUserCodeHash.delete(userCodeHash);
    challengesByDeviceCodeHash.delete(challenge.deviceCodeHash);
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

export function claimRemoteWebPairingChallengeExchange(
  deviceCode: string,
): ClaimRemoteWebPairingChallengeExchangeResult {
  const deviceCodeHash = hashSecret(deviceCode);
  const challenge = challengesByDeviceCodeHash.get(deviceCodeHash);
  if (!challenge) return { status: "invalid" };

  const now = nowMs();
  if (challenge.expiresAtMs <= now) {
    challengesByDeviceCodeHash.delete(deviceCodeHash);
    challengesByUserCodeHash.delete(challenge.userCodeHash);
    return { status: "expired" };
  }

  if (challenge.status === "pending") {
    return {
      status: "pending",
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }
  if (challenge.status === "exchanging") {
    return {
      status: "pending",
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }
  if (challenge.status === "consumed") return { status: "consumed" };

  challenge.status = "exchanging";
  challenge.exchangeStartedAtMs = now;
  return {
    status: "approved",
    publicBaseUrl: challenge.publicBaseUrl,
    verificationUri: challenge.verificationUri,
    expiresAt: new Date(challenge.expiresAtMs).toISOString(),
  };
}

export function completeRemoteWebPairingChallengeExchange(
  deviceCode: string,
): void {
  const challenge = challengesByDeviceCodeHash.get(hashSecret(deviceCode));
  if (!challenge || challenge.status !== "exchanging") return;

  challenge.status = "consumed";
  challenge.consumedAtMs = nowMs();
}

export function releaseRemoteWebPairingChallengeExchange(
  deviceCode: string,
): void {
  const challenge = challengesByDeviceCodeHash.get(hashSecret(deviceCode));
  if (!challenge || challenge.status !== "exchanging") return;

  challenge.status = "approved";
  challenge.exchangeStartedAtMs = undefined;
}

export function resetRemoteWebPairingChallengesForTests(): void {
  challengesByUserCodeHash.clear();
  challengesByDeviceCodeHash.clear();
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
