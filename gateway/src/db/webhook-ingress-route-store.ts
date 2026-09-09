/** Store for the webhook subpaths this assistant accepts from outside. */

import type { WebhookIngressRoute } from "@vellumai/gateway-client/gateway-ipc-contracts";
import { and, eq, inArray } from "drizzle-orm";

import {
  isValidWebhookIngressPath,
  PLUGIN_WEBHOOK_PATH_PREFIX,
} from "../velay/path-utils.js";
import { getGatewayDb } from "./connection.js";
import { webhookIngressRoutes } from "./schema.js";

/**
 * Type carried by the rows the plugin ingress gate owns, whose `source` is
 * therefore always a plugin name.
 *
 * This value is reserved: a reconcile treats a row carrying it as its own to
 * keep or remove wherever the row sits inside the plugin namespace, so
 * {@link registerWebhookIngressRoute} refuses it and a claim made through that
 * function survives the next reconcile, whatever its source name.
 */
export const PLUGIN_WEBHOOK_ROUTE_TYPE = "plugin";

const changeListeners = new Set<() => void>();

/**
 * Register a callback that fires after every registration or removal.
 * Returns an unsubscribe function.
 */
export function onWebhookIngressRoutesChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

function notifyChanged(): void {
  for (const cb of changeListeners) {
    cb();
  }
}

export interface RegisterWebhookIngressRouteInput {
  /** Exact subpath, leading slash included, under `/webhooks/`. */
  path: string;
  type: string;
  source?: string | null;
}

/**
 * Claim `path` for `type`. Registering the same path again refreshes its
 * registration time and keeps the original `createdAt`.
 *
 * {@link PLUGIN_WEBHOOK_ROUTE_TYPE} is refused, because a row carrying it
 * belongs to the plugin reconcile and would be removed the moment the path is
 * absent from what plugins declare.
 */
export function registerWebhookIngressRoute(
  input: RegisterWebhookIngressRouteInput,
): WebhookIngressRoute {
  const { path } = input;
  if (!isValidWebhookIngressPath(path)) {
    throw new Error(`Invalid webhook ingress path: ${path}`);
  }
  if (input.type === PLUGIN_WEBHOOK_ROUTE_TYPE) {
    throw new Error(
      `Webhook ingress route type "${PLUGIN_WEBHOOK_ROUTE_TYPE}" is reserved for plugin declarations`,
    );
  }

  const existing = readWebhookIngressRoute(path);
  const now = Date.now();
  const row: WebhookIngressRoute = {
    path,
    type: input.type,
    source: input.source ?? null,
    match: "exact",
    createdAt: existing?.createdAt ?? now,
    lastRegisteredAt: now,
  };

  getGatewayDb()
    .insert(webhookIngressRoutes)
    .values(row)
    .onConflictDoUpdate({
      target: webhookIngressRoutes.path,
      set: {
        type: row.type,
        source: row.source,
        lastRegisteredAt: row.lastRegisteredAt,
      },
    })
    .run();

  // Re-registering an unchanged row leaves the advertised path set identical,
  // so subscribers have nothing to react to.
  if (
    existing === undefined ||
    existing.type !== row.type ||
    existing.source !== row.source
  ) {
    notifyChanged();
  }
  return row;
}

/** Drop `path`. Returns true when a row was removed. */
export function unregisterWebhookIngressRoute(path: string): boolean {
  if (!hasWebhookIngressRoute(path)) {
    return false;
  }
  getGatewayDb()
    .delete(webhookIngressRoutes)
    .where(eq(webhookIngressRoutes.path, path))
    .run();
  notifyChanged();
  return true;
}

/** One path a plugin declaration currently entitles the gateway to serve. */
export interface PluginWebhookRouteClaim {
  path: string;
  /** Declaring plugin's name, stored as the row's `source`. */
  source: string;
}

/** What a reconcile changed, by path. */
export interface PluginWebhookRouteReconciliation {
  added: string[];
  removed: string[];
  /**
   * Claims the reconcile will not store: a path the registry cannot hold byte
   * for byte, or one outside the plugin namespace the reconcile owns. Skipped
   * rather than thrown, so one plugin declaring an unusable path cannot stop
   * every other plugin's paths from settling.
   */
  rejected: string[];
}

/**
 * Whether a persisted row is the reconcile's to keep or remove.
 *
 * The reconcile owns exactly the plugin namespace. A plugin-typed row outside
 * it, such as a `/webhooks/plugin` claim written through the public IPC, is
 * never touched, while a row inside it follows what plugins currently declare
 * whoever wrote it.
 */
function isReconcileOwned(route: WebhookIngressRoute): boolean {
  return (
    route.type === PLUGIN_WEBHOOK_ROUTE_TYPE &&
    route.path.startsWith(PLUGIN_WEBHOOK_PATH_PREFIX)
  );
}

/**
 * Make the registry's plugin rows equal `servable`.
 *
 * These rows are a mirror, not a record of events: a path is claimed for
 * exactly as long as the ingress gate would serve it. Deriving them from that
 * set rather than from approve and revoke callbacks lets any drift, such as a
 * plugin uninstalled while the gateway was down or a manifest edited into a
 * different digest, settle on the next reconcile.
 *
 * Only the rows {@link isReconcileOwned} accepts are removed, and only claims
 * inside that same namespace are written, so the mirror covers exactly the rows
 * it can also withdraw and a claim another subsystem registered is never
 * touched, whatever its type or source name.
 *
 * Fires the change listener once when anything moved, and not at all otherwise,
 * so an unchanged reconcile does not ask the tunnel to re-advertise.
 */
export function reconcilePluginWebhookIngressRoutes(
  servable: readonly PluginWebhookRouteClaim[],
): PluginWebhookRouteReconciliation {
  const desired = new Map<string, string>();
  const rejected: string[] = [];
  for (const claim of servable) {
    if (
      isValidWebhookIngressPath(claim.path) &&
      claim.path.startsWith(PLUGIN_WEBHOOK_PATH_PREFIX)
    ) {
      desired.set(claim.path, claim.source);
    } else {
      rejected.push(claim.path);
    }
  }

  const allRows = new Map(
    listWebhookIngressRoutes().map((route) => [route.path, route] as const),
  );
  const existing = new Map(
    [...allRows.values()]
      .filter(isReconcileOwned)
      .map((route) => [route.path, route] as const),
  );

  const removed = [...existing.keys()].filter((path) => !desired.has(path));
  const now = Date.now();
  const writes: WebhookIngressRoute[] = [];
  for (const [path, source] of desired) {
    // A row of another type at a desired path already admits it, and its
    // lifecycle belongs to whoever wrote it. Overwriting its ownership here
    // would hand it to the reconcile, and the two writers would then trade
    // the row back and forth, each swing forcing a tunnel reconnect.
    const foreign = allRows.get(path);
    if (foreign && foreign.type !== PLUGIN_WEBHOOK_ROUTE_TYPE) {
      continue;
    }
    const row = existing.get(path);
    if (row?.source === source) {
      continue;
    }
    writes.push({
      path,
      type: PLUGIN_WEBHOOK_ROUTE_TYPE,
      source,
      match: "exact",
      createdAt: row?.createdAt ?? now,
      lastRegisteredAt: now,
    });
  }

  if (removed.length === 0 && writes.length === 0) {
    return { added: [], removed: [], rejected };
  }

  const db = getGatewayDb();
  if (removed.length > 0) {
    db.delete(webhookIngressRoutes)
      .where(
        and(
          eq(webhookIngressRoutes.type, PLUGIN_WEBHOOK_ROUTE_TYPE),
          inArray(webhookIngressRoutes.path, removed),
        ),
      )
      .run();
  }
  for (const row of writes) {
    db.insert(webhookIngressRoutes)
      .values(row)
      .onConflictDoUpdate({
        target: webhookIngressRoutes.path,
        set: {
          type: row.type,
          source: row.source,
          lastRegisteredAt: row.lastRegisteredAt,
        },
      })
      .run();
  }
  notifyChanged();
  return { added: writes.map((row) => row.path), removed, rejected };
}

/** Every registered route. */
export function listWebhookIngressRoutes(): WebhookIngressRoute[] {
  return getGatewayDb().select().from(webhookIngressRoutes).all();
}

/** Whether `path` is registered. On the bridge's per-request path. */
export function hasWebhookIngressRoute(path: string): boolean {
  return (
    getGatewayDb()
      .select({ path: webhookIngressRoutes.path })
      .from(webhookIngressRoutes)
      .where(eq(webhookIngressRoutes.path, path))
      .get() !== undefined
  );
}

function readWebhookIngressRoute(
  path: string,
): WebhookIngressRoute | undefined {
  return getGatewayDb()
    .select()
    .from(webhookIngressRoutes)
    .where(eq(webhookIngressRoutes.path, path))
    .get();
}
