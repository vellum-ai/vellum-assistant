/** Keeps the webhook registry's plugin rows equal to what the ingress gate serves. */

import { reconcilePluginWebhookIngressRoutes } from "../db/webhook-ingress-route-store.js";
import { getLogger } from "../logger.js";
import {
  listServablePluginWebhookPaths,
  resolveCachedPluginIngress,
  resolvePluginIngress,
  subscribeToPluginIngressChanges,
  type PluginIngressResolution,
} from "./plugin-ingress-approvals.js";

const log = getLogger("plugin-webhook-route-sync");

/**
 * How often discovery is re-read on the watch's own account.
 *
 * Nothing tells the gateway a plugin was installed, and the shared cache
 * refreshes only when an inbound webhook asks it to, which a route that is not
 * yet claimed never gets. The timer is what closes that loop, so a plugin
 * installed while the gateway runs is reachable about this long afterwards.
 */
const DISCOVERY_POLL_INTERVAL_MS = 60_000;

// Armed by any reconcile failure or discovery change and cleared only by a
// settle that succeeded, so the poll retries failures from every call site,
// including an approval whose rows failed to settle after the grant was
// already persisted.
let routesDirty = false;

/**
 * Arm the retry for a settle that ran outside this module and failed.
 *
 * The approval and revocation handlers reconcile through the store directly,
 * because they report the reconciliation result to their caller. Marking the
 * routes dirty is how such a failure reaches the poll, so a grant that was
 * already persisted settles on a later tick rather than waiting for a
 * declaration change or a restart.
 */
export function markPluginWebhookRoutesDirty(): void {
  routesDirty = true;
}

/**
 * Recompute the registry's plugin rows from what `resolve` reports as
 * servable.
 *
 * A failure is logged and swallowed. Callers are startup and change
 * notifications, neither of which has anywhere to report to, and a registry
 * that failed to settle is a stale allowlist rather than a reason to stop
 * serving.
 */
export function reconcilePluginWebhookRoutes(
  resolve: () => PluginIngressResolution = resolvePluginIngress,
): boolean {
  try {
    const { added, removed, rejected } = reconcilePluginWebhookIngressRoutes(
      listServablePluginWebhookPaths(resolve()),
    );
    if (added.length > 0 || removed.length > 0) {
      log.info(
        { added: added.length, removed: removed.length },
        "Reconciled webhook routes against plugin ingress declarations",
      );
    }
    if (rejected.length > 0) {
      log.warn(
        { rejected },
        "Declared paths the webhook registry will not claim were skipped",
      );
    }
    routesDirty = false;
    return true;
  } catch (err) {
    log.warn(
      { err },
      "Failed to reconcile webhook routes against plugin ingress declarations",
    );
    routesDirty = true;
    return false;
  }
}

/**
 * Reconcile whenever plugin discovery changes, so a route the request path has
 * begun serving is claimed at the same time rather than at the next restart or
 * guardian decision. Installs, uninstalls, toggles and manifest edits all
 * reach the gateway this way and nothing else announces them. Discovery is
 * also re-read on a timer, because a route no allowlist carries yet draws no
 * request to refresh it on.
 *
 * The reconcile is deferred and coalesced: the notification arrives inside the
 * discovery refresh, which must not be re-entered, and a burst of changes is
 * one settle rather than one per notification. Returns an unsubscribe
 * function.
 */
export function watchPluginIngressForWebhookRoutes(opts?: {
  subscribe?: (cb: () => void) => () => void;
  resolve?: () => PluginIngressResolution;
  refresh?: () => void;
  pollIntervalMs?: number;
}): () => void {
  const subscribe = opts?.subscribe ?? subscribeToPluginIngressChanges;
  const resolve = opts?.resolve ?? resolveCachedPluginIngress;
  const refresh =
    opts?.refresh ??
    (() => {
      resolveCachedPluginIngress();
    });
  const pollIntervalMs = opts?.pollIntervalMs ?? DISCOVERY_POLL_INTERVAL_MS;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const scheduleSettle = () => {
    if (pending !== undefined) {
      return;
    }
    pending = setTimeout(() => {
      pending = undefined;
      reconcilePluginWebhookRoutes(resolve);
    }, 0);
    pending.unref?.();
  };

  const unsubscribe = subscribe(() => {
    routesDirty = true;
    scheduleSettle();
  });

  const poll = setInterval(() => {
    try {
      refresh();
    } catch (err) {
      log.warn({ err }, "Failed to refresh plugin ingress discovery");
    }
    if (routesDirty) {
      scheduleSettle();
    }
  }, pollIntervalMs);
  poll.unref?.();

  return () => {
    unsubscribe();
    clearInterval(poll);
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
  };
}
