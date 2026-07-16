/**
 * Direct (unbuffered) emit of a single `watchdog` telemetry event.
 *
 * The usual watchdog path persists to the SQLite `telemetry_events` outbox and
 * lets {@link ./usage-telemetry-reporter} batch and upload it later. That
 * durable buffer is the right default — it survives restarts and dedupes on
 * `daemon_event_id`. But it is the wrong tool for a check that fires *because*
 * SQLite is unusable: recording a corruption event into SQLite can hit the very
 * damage it is reporting, and the store's `recordWatchdogEvent` drags the whole
 * `db-connection` graph in behind it.
 *
 * This helper POSTs the event straight to the platform ingest instead. It is
 * best-effort: opt-out, missing credentials (early boot, before the CES
 * handshake), platform-disabled, and HTTP failures all no-op. No retry — a lost
 * event is acceptable for a rare, high-signal check. Deduped downstream on
 * `daemon_event_id` like every other telemetry event.
 */

import { v4 as uuid } from "uuid";

import { getPlatformOrganizationId, getPlatformUserId } from "../config/env.js";
import { VellumPlatformClient } from "../platform/client.js";
import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { arePlatformFeaturesEnabled } from "../platform/feature-gate.js";
import { getDeviceId } from "../util/device-id.js";
import { getLogger } from "../util/logger.js";
import { APP_VERSION } from "../version.js";
import { validateWireEvents } from "./telemetry-wire-validation.js";
import type { WatchdogTelemetryEvent } from "./types.js";

const log = getLogger("watchdog-direct-emit");

/** Platform telemetry ingest endpoint (same one the batched reporter POSTs to). */
const TELEMETRY_INGEST_PATH = "/v1/telemetry/ingest/";

/**
 * POST one `watchdog` event directly to the platform, bypassing the SQLite
 * buffer. Honors a confirmed `share_analytics` opt-out and the
 * platform-features gate. An unknown consent state emits: this path reports
 * SQLite corruption and has no outbox to defer into, and platform ingest
 * re-gates on consent authoritatively server-side. Never throws — the caller
 * is on a query hot path.
 */
export async function emitWatchdogEventDirect(
  checkName: string,
  detail: Record<string, unknown> | null,
  value: number | null = null,
): Promise<void> {
  try {
    // Drop only on a confirmed opt-out; unknown emits (no buffer to defer
    // into, and platform ingest re-gates on consent server-side).
    if (getRawShareAnalytics() === false) {
      return;
    }
    if (!arePlatformFeaturesEnabled()) return;

    // Authenticated-only. Null before the CES handshake resolves credentials;
    // the event is simply dropped (no durable backlog to retry from).
    const client = await VellumPlatformClient.create();
    if (!client) return;

    const event: WatchdogTelemetryEvent = {
      type: "watchdog",
      daemon_event_id: uuid(),
      recorded_at: Date.now(),
      check_name: checkName,
      value,
      detail,
      assistant_version: APP_VERSION,
    };

    // Pre-flush wire validation — observability only: warns when the server
    // would silently drop the event; the POST proceeds unchanged.
    validateWireEvents([event], log);

    const organizationId = getPlatformOrganizationId() || undefined;
    const userId = getPlatformUserId() || undefined;
    const resp = await client.fetch(TELEMETRY_INGEST_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: getDeviceId(),
        assistant_version: APP_VERSION,
        ...(organizationId ? { organization_id: organizationId } : {}),
        ...(userId ? { user_id: userId } : {}),
        events: [event],
      }),
    });
    // Consume the body to release the connection, mirroring the reporter.
    await resp.text();
    if (!resp.ok) {
      log.warn(
        { status: resp.status, checkName },
        "Direct watchdog telemetry POST failed (non-fatal)",
      );
    }
  } catch (err) {
    log.warn({ err, checkName }, "Direct watchdog telemetry emit failed");
  }
}
