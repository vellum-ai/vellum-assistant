/**
 * Serialized, deduplicated PATCH queue for the platform Assistant record.
 *
 * Each `enqueue` bumps a sequence number and chains onto the previous request,
 * so rapid changes collapse into one PATCH carrying the newest payload and a
 * stale in-flight response cannot overwrite a newer value. The dedup key is
 * scoped to the platform destination (base URL + assistant id), so
 * re-registering elsewhere re-sends an unchanged payload. With `maxAgeMs`, a
 * key only dedups while its last success is younger than that, and an unref'd
 * timer re-enqueues the last input at expiry so an idle long-lived process
 * re-sends without any caller. Best-effort: failures are logged, never
 * thrown, and leave the dedup key untouched; a failed request re-enqueues
 * itself on a bounded backoff (superseded by any new enqueue).
 */

import type { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

type Logger = ReturnType<typeof getLogger>;

type PatchBody = Record<string, unknown>;

export interface PatchPayload {
  /** Identifies the payload content; equal keys are not re-sent. */
  key: string;
  /** A function runs only after the key passes dedup; undefined skips. */
  body: PatchBody | (() => Promise<PatchBody | undefined>);
}

export interface SyncedKey {
  /** Destination-scoped dedup key of the last successful PATCH. */
  key: string;
  /** Epoch ms of that PATCH. */
  syncedAt: number;
}

export interface PlatformPatchQueueOptions<T> {
  log: Logger;
  /** Names the synced thing in log lines, e.g. "avatar". */
  label: string;
  /** Returns undefined to skip the PATCH entirely. */
  buildPayload: (
    input: T,
  ) => Promise<PatchPayload | undefined> | PatchPayload | undefined;
  /** Seeds the dedup key on first use (e.g. from disk). */
  loadSyncedKey?: () => SyncedKey | null;
  /** Called after each successful PATCH. */
  saveSyncedKey?: (synced: SyncedKey) => void;
  /** A matching key older than this re-sends, via a timer; omit to never expire. */
  maxAgeMs?: number;
  /** Backoff after each failed attempt; retries stop once exhausted. */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

export interface PlatformPatchQueue<T> {
  enqueue: (input: T) => void;
  /** Cancels the expiry and retry timers; queued requests still run. */
  dispose: () => void;
}

export function createPlatformPatchQueue<T = void>(
  options: PlatformPatchQueueOptions<T>,
): PlatformPatchQueue<T> {
  const {
    log,
    label,
    buildPayload,
    loadSyncedKey,
    saveSyncedKey,
    maxAgeMs,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  } = options;
  let lastSynced: SyncedKey | null | undefined;
  let seq = 0;
  let pending: Promise<void> = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function armExpiry(input: T): void {
    if (maxAgeMs === undefined || !lastSynced) {
      return;
    }
    clearTimeout(expiryTimer);
    const delay = Math.max(0, lastSynced.syncedAt + maxAgeMs - Date.now());
    expiryTimer = setTimeout(() => enqueue(input), delay);
    expiryTimer.unref?.();
  }

  function armRetry(input: T, requestSeq: number, attempt: number): void {
    const delay = retryDelaysMs[attempt];
    if (requestSeq !== seq || delay === undefined) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => schedule(input, attempt + 1), delay);
    retryTimer.unref?.();
  }

  async function run(
    input: T,
    requestSeq: number,
    attempt: number,
  ): Promise<void> {
    try {
      if (requestSeq !== seq) {
        return;
      }
      const client = await VellumPlatformClient.create();
      const assistantId = client?.platformAssistantId;
      if (!client || !assistantId) {
        return;
      }

      const payload = await buildPayload(input);
      if (!payload || requestSeq !== seq) {
        return;
      }
      const key = `${client.baseUrl}|${assistantId}|${payload.key}`;
      lastSynced ??= loadSyncedKey?.() ?? null;
      if (
        lastSynced?.key === key &&
        (maxAgeMs === undefined || Date.now() - lastSynced.syncedAt < maxAgeMs)
      ) {
        armExpiry(input);
        return;
      }
      const body =
        typeof payload.body === "function"
          ? await payload.body()
          : payload.body;
      if (!body || requestSeq !== seq) {
        return;
      }

      const resp = await client.fetch(
        `/v1/assistants/${encodeURIComponent(assistantId)}/`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (resp.ok) {
        lastSynced = { key, syncedAt: Date.now() };
        saveSyncedKey?.(lastSynced);
        armExpiry(input);
        log.info(
          { key: payload.key, assistantId },
          `Synced ${label} to platform`,
        );
      } else {
        log.warn(
          {
            status: resp.status,
            body: await resp.text(),
            assistantId,
            attempt,
          },
          `Failed to sync ${label} to platform`,
        );
        armRetry(input, requestSeq, attempt);
      }
    } catch (err) {
      log.warn({ err, attempt }, `Error syncing ${label} to platform`);
      armRetry(input, requestSeq, attempt);
    }
  }

  function schedule(input: T, attempt: number): void {
    const mySeq = ++seq;
    pending = pending.then(() => run(input, mySeq, attempt)).catch(() => {});
  }

  function enqueue(input: T): void {
    clearTimeout(retryTimer);
    schedule(input, 0);
  }

  return {
    enqueue,
    dispose(): void {
      clearTimeout(expiryTimer);
      clearTimeout(retryTimer);
    },
  };
}
