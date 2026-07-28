/**
 * Backwards-compat gate: subagent detail self-lookup.
 *
 * From assistant 0.11.0, `GET /subagents/:id` resolves the subagent's own
 * conversation id from the daemon's live/rehydrated manager state and treats
 * the `conversationId` query parameter as a fallback only (it also returns
 * `label` / `parentToolUseId` so a recovering client can rebuild identity).
 *
 * Older assistants trust the query parameter verbatim and parse whatever
 * conversation it names. A client recovering from a missed
 * `subagent_spawned` only knows the PARENT conversation id (that's what
 * `subagent_event` carries at the top level), so fetching detail against an
 * old assistant with that id would parse the parent conversation's messages
 * as if they were the subagent's: a wrong objective and a garbage timeline.
 *
 * Gate stub-entry detail hydration on this check: below the minimum the
 * stub renders from live stream events only (generic label, no history
 * backfill), which is degraded but never wrong.
 */
import { assistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.11.0";

/**
 * Snapshot check (safe outside React, stream handlers, store actions):
 * `true` when the connected assistant resolves the subagent conversation
 * itself, making detail hydration safe with only a parent conversation id.
 */
export function supportsSubagentDetailSelfLookup(): boolean {
  return assistantSupports(MIN_VERSION);
}
