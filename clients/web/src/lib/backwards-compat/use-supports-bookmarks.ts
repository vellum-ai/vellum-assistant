/**
 * Backwards-compat gate: message bookmarks.
 *
 * Vellum Assistant 0.8.1 added the bookmark routes
 * (`GET/POST/DELETE /v1/assistants/{id}/bookmarks`) and the
 * `bookmark.created` / `bookmark.deleted` SSE events (PR #30118). Older
 * assistants 404 those routes, so the web app hides every bookmark
 * affordance — the per-message hover / long-press toggle and the
 * Settings → Bookmarks tab — and keeps the shared list query disabled.
 * The transcript and Settings render exactly as they did before the
 * feature, with no control to invoke and no error surfaced.
 *
 * Before GA the `bookmarks` client feature flag doubled as an accidental
 * compatibility gate: an old assistant that lacked the routes also
 * reported no flag, so the UI stayed hidden. Removing the flag on GA
 * removed that gate — a current bundle against a pre-0.8.1 assistant would
 * otherwise fire the list query into a 404 ("Failed to load bookmarks")
 * and issue unsupported POST/DELETE writes that fail after an optimistic
 * update. This version gate restores the compatibility behavior the flag
 * used to provide. CDN-served bundles routinely connect to self-hosted
 * assistants of arbitrary age (the iOS shell loads the deployed SPA against
 * self-hosted gateways), so the gate is load-bearing.
 *
 * A render hook (not the `assistantSupports` snapshot) so the bookmark UI
 * appears the moment the version hydrates.
 *
 * MIN_VERSION is 0.8.1: the bookmark routes first shipped there (PR #30118,
 * merged 2026-05-09); v0.8.0 and older 404 them.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.1";

export function useSupportsBookmarks(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
