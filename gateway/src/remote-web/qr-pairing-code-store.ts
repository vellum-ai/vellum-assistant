import { createHash, randomBytes } from "node:crypto";

/**
 * In-memory store for host-minted QR pairing codes.
 *
 * The host machine mints a single-use, short-lived code (rendered as a QR by
 * the CLI); a phone that scans it presents the code to the public exchange
 * route for device-bound tokens. Possession of the code is the proof that the
 * presenter physically saw the host's screen, so a code is:
 *
 *   - **High-entropy**: 256 random bits, URL-safe base64 (rides a `#code=` URL
 *     fragment), so it cannot be guessed within its lifetime.
 *   - **Short-lived**: ~5 minutes, bounding the window a leaked QR is usable.
 *   - **Single-use**: burned atomically on the first successful exchange.
 *
 * Only the SHA-256 hash of a code is retained, so a memory dump never reveals a
 * live code. Mirrors the remote-web pairing-challenge store's persistence
 * choice (in-memory) and expiry handling.
 */

/** QR pairing codes are valid for 5 minutes. */
const CODE_TTL_MS = 5 * 60 * 1000;

/** Cap on concurrently-active codes, bounding memory from a runaway minter. */
const MAX_ACTIVE_CODES = 200;

/** 32 bytes = 256 bits of entropy. */
const CODE_BYTES = 32;

interface PendingQrPairingCode {
  expiresAtMs: number;
}

export interface CreatedQrPairingCode {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface QrPairingCodeCapacityLimit {
  retryAfterSeconds: number;
}

export type ClaimQrPairingCodeResult = { status: "ok" } | { status: "invalid" };

const codesByHash = new Map<string, PendingQrPairingCode>();
let nowForTests: (() => number) | null = null;

function nowMs(): number {
  return nowForTests?.() ?? Date.now();
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function cleanupExpiredCodes(now = nowMs()): void {
  for (const [hash, code] of codesByHash) {
    if (code.expiresAtMs <= now) {
      codesByHash.delete(hash);
    }
  }
}

/**
 * Capacity guard for the loopback mint route: returns a retry hint when the
 * store is full (after evicting expired codes), or null when there is room.
 */
export function checkQrPairingCodeCapacity(): QrPairingCodeCapacityLimit | null {
  const now = nowMs();
  cleanupExpiredCodes(now);

  if (codesByHash.size < MAX_ACTIVE_CODES) return null;

  let earliestExpiresAtMs = Number.POSITIVE_INFINITY;
  for (const code of codesByHash.values()) {
    earliestExpiresAtMs = Math.min(earliestExpiresAtMs, code.expiresAtMs);
  }

  return {
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((earliestExpiresAtMs - now) / 1000),
    ),
  };
}

export function createQrPairingCode(): CreatedQrPairingCode {
  cleanupExpiredCodes();

  let code = randomBytes(CODE_BYTES).toString("base64url");
  let codeHash = hashCode(code);
  while (codesByHash.has(codeHash)) {
    code = randomBytes(CODE_BYTES).toString("base64url");
    codeHash = hashCode(code);
  }

  const expiresAtMs = nowMs() + CODE_TTL_MS;
  codesByHash.set(codeHash, { expiresAtMs });

  return {
    code,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.ceil(CODE_TTL_MS / 1000),
  };
}

/**
 * Atomically burn a QR pairing code.
 *
 * A matched code is deleted before this returns, so a concurrent second claim
 * of the same code finds nothing and fails — the exchange is single-use. Every
 * non-`ok` case (missing, expired, already burned) reports the same "invalid"
 * so the caller can return one uniform error and never reveal which codes exist.
 */
export function claimQrPairingCode(code: string): ClaimQrPairingCodeResult {
  const codeHash = hashCode(code);
  const pending = codesByHash.get(codeHash);
  if (!pending) return { status: "invalid" };

  // Burn on any terminal outcome: a matched code is spent even when expired.
  codesByHash.delete(codeHash);

  if (pending.expiresAtMs <= nowMs()) return { status: "invalid" };
  return { status: "ok" };
}

export function resetQrPairingCodesForTests(): void {
  codesByHash.clear();
  nowForTests = null;
}

export function setQrPairingCodeNowForTests(now: () => number): void {
  nowForTests = now;
}

export function getQrPairingCodeCountForTests(): number {
  return codesByHash.size;
}
