/** Store for the webhook subpaths this assistant accepts from outside. */

import type { WebhookIngressRoute } from "@vellumai/gateway-client/gateway-ipc-contracts";
import { and, eq, inArray } from "drizzle-orm";

import {
  isSafeOriginRelativePath,
  WEBHOOK_PATH_PREFIX,
} from "../velay/path-utils.js";
import { getGatewayDb } from "./connection.js";
import { webhookIngressRoutes } from "./schema.js";

const MAX_WEBHOOK_PATH_LENGTH = 512;

/**
 * Type carried by the rows the plugin ingress approval gate owns, whose
 * `source` is therefore always a plugin name.
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

/**
 * Consecutive dots inside a segment are part of a name, so only a segment that
 * is exactly `..` is traversal. The path is percent-decoded first because a
 * consumer downstream may decode before it splits the path on slashes. A
 * decoded backslash is refused outright because a URL parser treats it as a
 * separator, which would turn `/webhooks/foo%5c..%5cadmin` into `/webhooks/admin`.
 */
function hasTraversalSegment(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return decoded.includes("\\") || decoded.split("/").includes("..");
}

/**
 * Paths are stored verbatim and compared byte for byte, so the only shapes
 * refused are the ones that would not survive that: anything outside the
 * webhook namespace, anything a URL parser would rewrite, and traversal.
 */
function isValidWebhookIngressPath(path: string): boolean {
  return (
    path.length <= MAX_WEBHOOK_PATH_LENGTH &&
    path.startsWith(WEBHOOK_PATH_PREFIX) &&
    !hasTraversalSegment(path) &&
    !/\s/.test(path) &&
    isSafeOriginRelativePath(path)
  );
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
 */
export function registerWebhookIngressRoute(
  input: RegisterWebhookIngressRouteInput,
): WebhookIngressRoute {
  const { path } = input;
  if (!isValidWebhookIngressPath(path)) {
    throw new Error(`Invalid webhook ingress path: ${path}`);
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

/**
 * Drop every plugin route registered for `source`. Returns how many rows were
 * removed.
 *
 * Scoped to plugin rows so that revoking a plugin's grant cannot take out a
 * route some other subsystem registered under a colliding source name.
 */
export function unregisterWebhookIngressRoutesBySource(source: string): number {
  const match = and(
    eq(webhookIngressRoutes.type, PLUGIN_WEBHOOK_ROUTE_TYPE),
    eq(webhookIngressRoutes.source, source),
  );
  const matched = getGatewayDb()
    .select({ path: webhookIngressRoutes.path })
    .from(webhookIngressRoutes)
    .where(match)
    .all();
  if (matched.length === 0) {
    return 0;
  }
  getGatewayDb().delete(webhookIngressRoutes).where(match).run();
  notifyChanged();
  return matched.length;
}

/**
 * Drop plugin routes whose source is not among `approvedSources`. Returns how
 * many rows were removed.
 *
 * A plugin route is only ever written alongside an approval, so a row for a
 * plugin holding none is left over from an uninstall or a revocation that
 * happened while the gateway was not running.
 */
export function unregisterOrphanedPluginWebhookIngressRoutes(
  approvedSources: readonly string[],
): number {
  const approved = new Set(approvedSources);
  const orphaned = listWebhookIngressRoutes().filter(
    (route) =>
      route.type === PLUGIN_WEBHOOK_ROUTE_TYPE &&
      (route.source === null || !approved.has(route.source)),
  );
  if (orphaned.length === 0) {
    return 0;
  }
  getGatewayDb()
    .delete(webhookIngressRoutes)
    .where(
      inArray(
        webhookIngressRoutes.path,
        orphaned.map((route) => route.path),
      ),
    )
    .run();
  notifyChanged();
  return orphaned.length;
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
