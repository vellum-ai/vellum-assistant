/**
 * Serialized, deduplicated PATCH queue for the platform Assistant record.
 *
 * Each `enqueue` bumps a sequence number and chains onto the previous request,
 * so rapid changes collapse into one PATCH carrying the newest payload and a
 * stale in-flight response cannot overwrite a newer value. The dedup key is
 * scoped to the platform destination (base URL + assistant id), so
 * re-registering elsewhere re-sends an unchanged payload. Best-effort: failures
 * are logged, never thrown, and leave the dedup key untouched so the next
 * enqueue retries.
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

export interface PlatformPatchQueueOptions<T> {
  log: Logger;
  /** Names the synced thing in log lines, e.g. "avatar". */
  label: string;
  /** Returns undefined to skip the PATCH entirely. */
  buildPayload: (
    input: T,
  ) => Promise<PatchPayload | undefined> | PatchPayload | undefined;
  /** Seeds the dedup key on first use (e.g. from disk). */
  loadSyncedKey?: () => string | null;
  /** Called after each successful PATCH with the destination-scoped key. */
  saveSyncedKey?: (key: string) => void;
}

export interface PlatformPatchQueue<T> {
  enqueue: (input: T) => void;
}

export function createPlatformPatchQueue<T = void>(
  options: PlatformPatchQueueOptions<T>,
): PlatformPatchQueue<T> {
  const { log, label, buildPayload, loadSyncedKey, saveSyncedKey } = options;
  let lastSyncedKey: string | null | undefined;
  let seq = 0;
  let pending: Promise<void> = Promise.resolve();

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
      lastSyncedKey ??= loadSyncedKey?.() ?? null;
      if (key === lastSyncedKey) {
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
        lastSyncedKey = key;
        saveSyncedKey?.(key);
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

  return {
    enqueue(input: T): void {
      const mySeq = ++seq;
      pending = pending.then(() => run(input, mySeq)).catch(() => {});
    },
  };
}
