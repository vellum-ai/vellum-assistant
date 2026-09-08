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
