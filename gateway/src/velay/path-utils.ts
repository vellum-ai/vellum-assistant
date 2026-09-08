/**
 * Path shapes shared by the Velay bridge and the webhook ingress route store.
 *
 * This module holds no imports of its own so the two sides can agree on what a
 * webhook path looks like without depending on each other.
 */

/** Every path the webhook ingress registry can claim sits under this prefix. */
export const WEBHOOK_PATH_PREFIX = "/webhooks/";

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
