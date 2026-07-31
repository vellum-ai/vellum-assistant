/**
 * Scoping for `window.vellum.subscribe` (see `sandbox-bridge.ts` /
 * `use-sandbox-fetch-proxy.ts`).
 *
 * A sandboxed app may only receive `sync_changed` invalidations for the tags
 * it explicitly subscribed to, and never for the host's reserved sync
 * namespaces — forwarding those would leak host activity (conversation
 * traffic, config/theme/schedule changes, the apps/plugins lists) into
 * untrusted app code. Custom tags an app's own routes emit pass through, so an
 * app can drive live refreshes off its own `publishSyncInvalidation` without
 * polling.
 *
 * `sync_changed` carries no payload — only which resource went stale — and the
 * authenticated fetch proxy remains the real access gate; this filter is
 * defense-in-depth on top of that.
 */

/** Sync-tag namespaces reserved for the host — never forwarded to sandboxed apps. */
export const RESERVED_SYNC_TAG_PREFIXES = [
  "assistant:",
  "conversation:",
  "conversations:",
  "apps:",
  "plugins:",
  "feature-flags:",
] as const;

export function isReservedSyncTag(tag: string): boolean {
  return RESERVED_SYNC_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/**
 * The tags from a `sync_changed` event that are safe to deliver to an app that
 * subscribed to `subscribedTags`: the intersection, minus any reserved host
 * namespace. An empty subscription (no tags) receives nothing — an app must
 * name the tags it wants (default-deny).
 */
export function forwardableSyncTags(
  subscribedTags: readonly string[],
  eventTags: readonly string[],
): string[] {
  if (subscribedTags.length === 0) {
    return [];
  }
  const wanted = new Set(subscribedTags);
  return eventTags.filter((tag) => wanted.has(tag) && !isReservedSyncTag(tag));
}
