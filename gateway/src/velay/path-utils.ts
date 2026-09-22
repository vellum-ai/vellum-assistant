/**
 * Path shapes shared by the Velay bridge, the webhook ingress route store, and
 * the plugin declarations whose paths are composed into that registry.
 *
 * This module holds no imports of its own so those sides can agree on what a
 * webhook path looks like without depending on each other.
 */

/** Every path the webhook ingress registry can claim sits under this prefix. */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";

/**
 * Namespace reserved for plugin-declared routes. Every plugin webhook path is
 * composed under it, and the plugin reconcile owns exactly the rows inside it.
 */
export const PLUGIN_WEBHOOK_PATH_PREFIX = `${WEBHOOK_PATH_PREFIX}plugins/`;

/**
 * Longest path the webhook ingress registry stores. Anything that composes a
 * path destined for the registry has to fit its longest spelling inside this,
 * because a path the registry refuses is one Velay is never told to forward.
 */
export const MAX_WEBHOOK_INGRESS_PATH_LENGTH = 512;

export function isSafeOriginRelativePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("?") || path.includes("#")) {
    return false;
  }
  try {
    const parsed = new URL(path, "http://127.0.0.1");
    return parsed.origin === "http://127.0.0.1" && parsed.pathname === path;
  } catch {
    return false;
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
 * Whether the webhook ingress registry will claim `path`.
 *
 * Paths are stored verbatim and compared byte for byte, so the only shapes
 * refused are the ones that would not survive that: anything outside the
 * webhook namespace, anything a URL parser would rewrite, and traversal.
 *
 * This lives beside the shapes rather than in the store because plugin
 * discovery has to answer the same question about a path it is composing. A
 * composed path the registry would refuse is a route the ingress resolver
 * reports servable and the registry holds no row for, so discovery rejects the
 * declaration instead of publishing an unclaimable route.
 */
export function isValidWebhookIngressPath(path: string): boolean {
  return (
    path.length <= MAX_WEBHOOK_INGRESS_PATH_LENGTH &&
    path.startsWith(WEBHOOK_PATH_PREFIX) &&
    !hasTraversalSegment(path) &&
    !/\s/.test(path) &&
    isSafeOriginRelativePath(path)
  );
}
