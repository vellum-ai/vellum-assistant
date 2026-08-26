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
 * thrown, and leave the dedup key untouched so the next enqueue retries.
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
}

export interface PlatformPatchQueue<T> {
  enqueue: (input: T) => void;
  /** Cancels the expiry timer; queued requests still run. */
  dispose: () => void;
}

export function createPlatformPatchQueue<T = void>(
  options: PlatformPatchQueueOptions<T>,
): PlatformPatchQueue<T> {
  const { log, label, buildPayload, loadSyncedKey, saveSyncedKey, maxAgeMs } =
    options;
  let lastSynced: SyncedKey | null | undefined;
  let seq = 0;
  let pending: Promise<void> = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function armExpiry(input: T): void {
    if (maxAgeMs === undefined || !lastSynced) {
      return;
    }
    clearTimeout(expiryTimer);
    const delay = Math.max(0, lastSynced.syncedAt + maxAgeMs - Date.now());
    expiryTimer = setTimeout(() => enqueue(input), delay);
    expiryTimer.unref?.();
  }

  async function run(input: T, requestSeq: number): Promise<void> {
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
          { status: resp.status, body: await resp.text(), assistantId },
          `Failed to sync ${label} to platform`,
        );
      }
    } catch (err) {
      log.warn({ err }, `Error syncing ${label} to platform`);
    }
  }

  function enqueue(input: T): void {
    const mySeq = ++seq;
    pending = pending.then(() => run(input, mySeq)).catch(() => {});
  }

  return {
    enqueue,
    dispose(): void {
      clearTimeout(expiryTimer);
    },
  };
}
