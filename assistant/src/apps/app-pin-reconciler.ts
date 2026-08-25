/**
 * Level-based reconciler converging `app_pins` onto the apps that exist.
 *
 * A workspace app's id is a UUID, so a pin left behind when one is deleted can
 * never be adopted and the app list simply never returns it. A plugin app's id
 * is a path identity, `plugins~<plugin>~<appDir>`, and `listPluginApps` omits a
 * plugin that is disabled or uninstalled. Retiring one and bringing it back
 * rebuilds the same id, so a pin left behind returns to the sidebar with it,
 * for an app the user had no way to unpin while it was hidden. Converging on
 * every plugin-set change is what keeps a retirement from being undone.
 *
 * Triggers mirror `schedule/plugin-schedule-reconciler.ts`, which solves the
 * same problem for plugin-declared schedules: daemon startup
 * (`daemon/lifecycle.ts`), plugin-set convergence (`plugins/mtime-cache.ts`),
 * and a periodic backstop sweep (`runtime/http-server.ts`) that covers the
 * `.disabled` sentinel, which the CLI flips out of process without poking the
 * source reconcile.
 *
 * Self-contained in the same way: it never throws, and it checks database
 * readiness itself rather than relying on its callers to be ordered after
 * migrations.
 */

import { getDbMigrationReadiness } from "../daemon/daemon-readiness.js";
import { publishAppsChanged } from "../runtime/sync/resource-sync-events.js";
import { getLogger } from "../util/logger.js";
import { listAppPins, removeAppPin } from "./app-pin-store.js";
import { listApps, listPluginApps } from "./app-store.js";

const log = getLogger("app-pin-reconciler");

/** How often the backstop sweep converges, matching the schedule reconciler. */
const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/** Drop every pin whose app is not currently installed. Never throws. */
export function reconcileAppPins(): void {
  if (!getDbMigrationReadiness().ready) {
    return;
  }
  try {
    const live = new Set([
      ...listApps().map((app) => app.id),
      ...listPluginApps().map((app) => app.id),
    ]);
    const stale = listAppPins().filter((pin) => !live.has(pin.appId));
    for (const pin of stale) {
      removeAppPin(pin.appId);
    }
    if (stale.length > 0) {
      log.info(
        { removed: stale.map((pin) => pin.appId) },
        "Dropped pins for apps that are no longer installed",
      );
      /* A pass has no originating client, and every other pin write announces
         itself, so a client would otherwise keep rendering a pin this just
         deleted until some unrelated refetch. */
      publishAppsChanged();
    }
  } catch (err) {
    log.error({ err }, "app pin reconcile failed");
  }
}

/** Start the periodic backstop sweep. Idempotent. */
export function startAppPinReconcileSweep(): void {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    try {
      reconcileAppPins();
    } finally {
      sweepInProgress = false;
    }
  }, SWEEP_INTERVAL_MS);
}

/** Stop the periodic sweep. Used in tests and shutdown. */
export function stopAppPinReconcileSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}
