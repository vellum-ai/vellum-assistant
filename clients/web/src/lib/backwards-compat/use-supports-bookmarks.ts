/**
 * Backwards-compat gate: message bookmarks.
 *
 * The bookmark routes (`GET/POST/DELETE /v1/assistants/{id}/bookmarks`) and
 * the `bookmark.created` / `bookmark.deleted` SSE events first ship in
 * assistant 0.8.1 (PR #30118, merged 2026-05-09), so MIN_VERSION is 0.8.1.
 * Assistants older than that 404 the routes, so the web app hides every
 * bookmark affordance — the per-message hover / long-press toggle and the
 * Settings → Bookmarks tab — and keeps the shared list query disabled. The
 * transcript and Settings render with no bookmark control to invoke and no
 * error surfaced.
 *
 * The gate is load-bearing because one CDN-served bundle serves self-hosted
 * assistants of arbitrary age (the iOS shell loads the deployed SPA against
 * self-hosted gateways). Absent the gate, a current bundle pointed at a
 * pre-0.8.1 assistant fires the list query into a 404 ("Failed to load
 * bookmarks") and issues POST/DELETE writes that fail after an optimistic
 * update.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports` — see its
 * JSDoc in `./utils.ts` for the atomic version+owner snapshot and
 * conservative unknown/mismatch semantics — so a version fetched for one
 * assistant never authorizes another's routes mid-switch. A render hook (not
 * the `assistantSupports` snapshot) so the bookmark UI appears the moment the
 * version hydrates.
 */
import { useAssistantScopedSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.8.1";

/**
 * Returns `true` when the assistant that owns the bookmark surface
 * (`ownerAssistantId` — the active assistant whose transcript or Settings are
 * rendered) is new enough to serve the bookmark routes. Conservative
 * (`false`) until the scoped version hydrates and on any owner mismatch, so
 * every bookmark affordance stays hidden and the list query idle.
 */
export function useSupportsBookmarks(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
