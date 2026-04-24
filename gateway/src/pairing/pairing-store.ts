/**
 * In-memory pairing request store with TTL.
 *
 * Each pairing request lives for at most TTL_MS (5 minutes) before
 * being swept as expired. Status transitions:
 *   registered → pending → approved | denied | expired
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { getLogger } from "../logger.js";

const log = getLogger("pairing-store");

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_SWEEP_INTERVAL_MS = 30_000; // 30 seconds

export type PairingStatus =
  | "registered"
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export interface PairingRequest {
  pairingRequestId: string;
  hashedPairingSecret: string;
  hashedDeviceId?: string;
  deviceName?: string;
  status: PairingStatus;
  gatewayUrl: string;
  localLanUrl: string | null;
  bearerToken?: string;
  createdAt: number;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class PairingStore {
  private requests = new Map<string, PairingRequest>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.sweepTimer = setInterval(
      () => this.sweep(),
      PAIRING_SWEEP_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.requests.clear();
  }

  /**
   * Pre-register a pairing request (called when QR is displayed).
   * Idempotent: if the same ID exists and secret matches, overwrite.
   * Returns false with 'conflict' if ID exists but secret doesn't match,
   * or 'active_pairing' if another pairing request is already in progress.
   */
  register(params: {
    pairingRequestId: string;
    pairingSecret: string;
    gatewayUrl: string;
    localLanUrl?: string | null;
  }): { ok: true } | { ok: false; reason: "conflict" | "active_pairing" } {
    const hashedSecret = hashValue(params.pairingSecret);
    const existing = this.requests.get(params.pairingRequestId);

    if (existing) {
      if (!timingSafeCompare(existing.hashedPairingSecret, hashedSecret)) {
        return { ok: false, reason: "conflict" };
      }
    }

    // Reject if another pairing request is already active (registered or pending).
    for (const entry of this.requests.values()) {
      if (entry.pairingRequestId === params.pairingRequestId) continue;
      if (entry.status === "registered" || entry.status === "pending") {
        log.warn(
          {
            existingPairingRequestId: entry.pairingRequestId,
            newPairingRequestId: params.pairingRequestId,
          },
          "Rejected pairing registration — another pairing is already in progress",
        );
        return { ok: false, reason: "active_pairing" };
      }
    }

    this.requests.set(params.pairingRequestId, {
      pairingRequestId: params.pairingRequestId,
      hashedPairingSecret: hashedSecret,
      status: "registered",
      gatewayUrl: params.gatewayUrl,
      localLanUrl: params.localLanUrl ?? null,
      createdAt: Date.now(),
    });
    log.info(
      { pairingRequestId: params.pairingRequestId },
      "Pairing request registered",
    );
    return { ok: true };
  }

  /**
   * iOS initiates a pairing request. Validates the secret and transitions
   * the entry to "pending" (or "approved" if auto-approved).
   */
  beginRequest(params: {
    pairingRequestId: string;
    pairingSecret: string;
    deviceId: string;
    deviceName: string;
  }):
    | { ok: true; entry: PairingRequest }
    | {
        ok: false;
        reason: "not_found" | "invalid_secret" | "expired" | "already_paired";
      } {
    const entry = this.requests.get(params.pairingRequestId);
    if (!entry) {
      return { ok: false, reason: "not_found" };
    }

    if (entry.status === "expired" || entry.status === "denied") {
      return { ok: false, reason: "expired" };
    }

    const hashedSecret = hashValue(params.pairingSecret);
    if (!timingSafeCompare(entry.hashedPairingSecret, hashedSecret)) {
      return { ok: false, reason: "invalid_secret" };
    }

    const hashedDeviceId = hashValue(params.deviceId);

    if (
      entry.hashedDeviceId &&
      !timingSafeCompare(entry.hashedDeviceId, hashedDeviceId)
    ) {
      log.warn(
        { pairingRequestId: params.pairingRequestId },
        "Pairing request already bound to a different device",
      );
      return { ok: false, reason: "already_paired" };
    }

    entry.hashedDeviceId = hashedDeviceId;
    entry.deviceName = params.deviceName;
    if (entry.status === "registered") {
      entry.status = "pending";
    }
    return { ok: true, entry };
  }

  approve(
    pairingRequestId: string,
    bearerToken: string,
  ): PairingRequest | null {
    const entry = this.requests.get(pairingRequestId);
    if (!entry) return null;
    entry.status = "approved";
    entry.bearerToken = bearerToken;
    return entry;
  }

  deny(pairingRequestId: string): PairingRequest | null {
    const entry = this.requests.get(pairingRequestId);
    if (!entry) return null;
    entry.status = "denied";
    return entry;
  }

  get(pairingRequestId: string): PairingRequest | null {
    return this.requests.get(pairingRequestId) ?? null;
  }

  validateSecret(pairingRequestId: string, secret: string): boolean {
    const entry = this.requests.get(pairingRequestId);
    if (!entry) return false;
    const hashedSecret = hashValue(secret);
    return timingSafeCompare(entry.hashedPairingSecret, hashedSecret);
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of this.requests) {
      if (now - entry.createdAt > PAIRING_TTL_MS) {
        if (entry.status !== "approved") {
          entry.status = "expired";
          changed = true;
        }
        // Remove entries older than 2x TTL regardless of status
        if (now - entry.createdAt > PAIRING_TTL_MS * 2) {
          this.requests.delete(id);
          changed = true;
          log.debug({ pairingRequestId: id }, "Pairing request swept");
        }
      }
    }
    if (changed) {
      log.debug("Sweep completed with changes");
    }
  }
}
