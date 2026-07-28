/**
 * Backwards-compat gate: subagent recovery for a missed `subagent_spawned`.
 *
 * From assistant 0.10.13 the daemon carries everything a client needs to
 * rebuild subagent store entries it never saw spawn:
 *
 * - `GET /subagents/:id` resolves the subagent's own conversation id from
 *   live/rehydrated manager state (the `conversationId` query parameter is a
 *   fallback only) and returns `label` / `parentToolUseId`.
 * - `GET /subagents/reconcile` returns per-child identity (`label`,
 *   `conversationId` — the subagent's OWN id — and `parentToolUseId`)
 *   alongside live status, so a conversation load can materialize entries
 *   for every subagent the daemon knows about.
 *
 * Older assistants return status-only reconcile data and trust the detail
 * route's `conversationId` parameter verbatim. A client recovering mid-run
 * only knows the PARENT conversation id (that's what `subagent_event`
 * carries), so fetching detail against an old assistant with that id would
 * parse the parent conversation's messages as if they were the subagent's —
 * a wrong objective and a garbage timeline.
 *
 * Gate both recovery paths (stub detail hydration and reconcile-on-load) on
 * this check: below the minimum, recovered stubs render from live stream
 * events only (generic label, no history backfill) — degraded but never
 * wrong.
 */
import {
  assistantSupports,
  useAssistantSupports,
} from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.13";

/**
 * Snapshot check (safe outside React — stream handlers, store actions):
 * `true` when the connected assistant supports the recovery contract above.
 */
export function supportsSubagentRecovery(): boolean {
  return assistantSupports(MIN_VERSION);
}

/**
 * Hook variant for render paths (e.g. the reconcile-on-load effect), so the
 * gated code path lights up the moment the assistant version hydrates.
 */
export function useSupportsSubagentRecovery(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
