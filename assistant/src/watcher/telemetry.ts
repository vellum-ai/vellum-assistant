/**
 * Watcher usage telemetry — lifecycle-event breadcrumbs that let fleet
 * analytics answer "is anyone using watchers, and what do they cost?"
 * ahead of the planned watcher → skills-and-schedules migration.
 *
 * Both event shapes ship through the existing lifecycle-event telemetry
 * pipeline, so they inherit its `collectUsageData` opt-out gate and need
 * no wire-contract or platform-side changes:
 *
 * - `watcher_enabled:<providerId>` — one per enabled watcher, at most
 *   once per 24h per daemon. Counts devices that have watchers
 *   configured, including ones whose providers rarely produce events.
 * - `watcher_llm_processed:<providerId>:<conversationId>` — one per
 *   watcher tick that ran an LLM background job. The conversation id is
 *   embedded so analytics can join against `llm_usage` events for exact
 *   cost attribution.
 *
 * Telemetry must never break the polling loop, so every entry point
 * swallows storage errors.
 */

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../memory/checkpoints.js";
import { recordLifecycleEvent } from "../memory/lifecycle-events-store.js";
import { getLogger } from "../util/logger.js";
import { listWatchers } from "./watcher-store.js";

const log = getLogger("watcher-telemetry");

const INVENTORY_CHECKPOINT_KEY = "telemetry:watchers:inventory_last_recorded";
export const WATCHER_INVENTORY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Record one `watcher_enabled:<providerId>` lifecycle event per enabled
 * watcher, at most once per 24h. Called from every watcher tick; the
 * checkpoint advances only after the events are recorded, so a transient
 * storage failure retries on the next tick instead of skipping a day.
 * Retries can duplicate events for watchers recorded before the failure
 * point — an acceptable overcount for best-effort telemetry, where losing
 * a full day's inventory would not be.
 */
export function recordWatcherInventoryIfDue(now: number): void {
  try {
    const last = Number(getMemoryCheckpoint(INVENTORY_CHECKPOINT_KEY) ?? "0");
    if (now - last < WATCHER_INVENTORY_INTERVAL_MS) return;
    for (const watcher of listWatchers({ enabledOnly: true })) {
      recordLifecycleEvent(`watcher_enabled:${watcher.providerId}`);
    }
    setMemoryCheckpoint(INVENTORY_CHECKPOINT_KEY, String(now));
  } catch (err) {
    log.warn({ err }, "Failed to record watcher inventory telemetry");
  }
}

/**
 * Record a `watcher_llm_processed:<providerId>:<conversationId>`
 * lifecycle event for a watcher tick that bootstrapped an LLM background
 * job. Recorded whenever a conversation was created — even if the job
 * later failed — because tokens may already have been spent.
 */
export function recordWatcherLlmProcessed(
  providerId: string,
  conversationId: string,
): void {
  try {
    recordLifecycleEvent(
      `watcher_llm_processed:${providerId}:${conversationId}`,
    );
  } catch (err) {
    log.warn({ err }, "Failed to record watcher LLM-processed telemetry");
  }
}
