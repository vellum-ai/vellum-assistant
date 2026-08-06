/**
 * Cross-process quiesce lease for graceful drains.
 *
 * `vellum sleep --wait` sets a short-TTL lease before stopping the assistant;
 * every background-work claim/fire site (heartbeat, the daemon's
 * watcher/sequence tick, the schedule worker's claim tick, the memory jobs
 * worker) checks it and stops STARTING new work while it is active. Enqueue
 * paths are unaffected — queued work runs after the restart.
 *
 * The lease is a single `memory_checkpoints` row on the main database so the
 * daemon and both worker processes read the same value. The value is an
 * epoch-ms deadline, refreshed by the waiting client, so a dead client can
 * never silence background work for longer than one TTL. Readers fail OPEN —
 * a missing, malformed, or unreadable lease means "not quiesced".
 */

import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "./checkpoints.js";

const QUIESCE_UNTIL_KEY = "lifecycle:quiesce_until";

export const MIN_QUIESCE_TTL_MS = 5_000;
export const MAX_QUIESCE_TTL_MS = 10 * 60_000;
export const DEFAULT_QUIESCE_TTL_MS = 60_000;

/**
 * Arm (or refresh) the quiesce lease. Returns the lease deadline (epoch ms).
 *
 * Throws when the lease cannot be persisted — callers that promise a drain
 * must surface the failure rather than pretend background work is paused.
 */
export function setLifecycleQuiesce(
  ttlMs: number = DEFAULT_QUIESCE_TTL_MS,
): number {
  const clamped = Math.min(
    Math.max(Math.floor(ttlMs), MIN_QUIESCE_TTL_MS),
    MAX_QUIESCE_TTL_MS,
  );
  const quiescedUntil = Date.now() + clamped;
  setMemoryCheckpoint(QUIESCE_UNTIL_KEY, String(quiescedUntil));
  return quiescedUntil;
}

/**
 * The active lease deadline, or null when no unexpired lease exists.
 * Fail-open: any read or parse failure reads as "no lease".
 */
export function getLifecycleQuiesceUntil(): number | null {
  let raw: string | null;
  try {
    raw = getMemoryCheckpoint(QUIESCE_UNTIL_KEY);
  } catch {
    return null;
  }
  if (raw == null) {
    return null;
  }
  const until = Number.parseInt(raw, 10);
  if (!Number.isFinite(until) || until <= Date.now()) {
    return null;
  }
  return until;
}

/** True while an unexpired quiesce lease is active. Fail-open. */
export function isLifecycleQuiesced(): boolean {
  return getLifecycleQuiesceUntil() != null;
}

/** Drop the lease. Best-effort — a failure leaves the TTL to expire it. */
export function clearLifecycleQuiesce(): void {
  try {
    deleteMemoryCheckpoint(QUIESCE_UNTIL_KEY);
  } catch {
    // Fail-soft: the lease self-expires.
  }
}
