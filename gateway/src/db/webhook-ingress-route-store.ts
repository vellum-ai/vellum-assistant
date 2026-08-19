/** Store for the webhook subpaths this assistant accepts from outside. */

import { eq } from "drizzle-orm";

import { isSafeOriginRelativePath } from "../velay/bridge-utils.js";
import { getGatewayDb } from "./connection.js";
import { webhookIngressRoutes } from "./schema.js";

export interface WebhookIngressRoute {
  path: string;
  type: string;
  source: string | null;
  match: "exact";
  createdAt: number;
  lastRegisteredAt: number;
}

const WEBHOOK_PATH_PREFIX = "/webhooks/";
const MAX_WEBHOOK_PATH_LENGTH = 512;

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
 * consumer downstream may decode before it splits the path on slashes.
 */
function hasTraversalSegment(path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  return decoded.split("/").includes("..");
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
