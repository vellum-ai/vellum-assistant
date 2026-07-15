/**
 * Backwards-compat gate: non-interactive voice turns.
 *
 * Voice calls are non-interactive: the daemon forces
 * `supportsDynamicUi: false` on voice turns, so the assistant can no
 * longer raise interactive UI surfaces (e.g. `oauth_connect`) mid-call —
 * it speaks guidance instead and the user connects after the call.
 *
 * The web app always serves the latest bundle, but the assistant can be
 * any locally-installed version. An older assistant still raises
 * `oauth_connect` surfaces during voice turns, and the voice room is a
 * full-app modal over a pointer-events-disabled transcript — the
 * transcript's copy of the card is invisible and unclickable, so without
 * the room's own reachable card (JARVIS-1287) an OAuth-needed voice turn
 * would stall until the user ends the call. The room therefore keeps its
 * connect card as a fallback for assistants below `MIN_VERSION`.
 *
 * - Old behavior (< MIN_VERSION): voice turns can attach `oauth_connect`
 *   surfaces; the voice room renders its own reachable copy of the
 *   pending card.
 * - New behavior (>= MIN_VERSION): voice turns can never raise UI
 *   surfaces; the room card is dead weight and stays hidden.
 *
 * MIN_VERSION is 0.10.10 — the first release that can ship the
 * daemon-side `supportsDynamicUi: false` enforcement on voice turns
 * (v0.10.9 was cut 2026-07-14, before that change merged, so 0.10.9
 * assistants still raise surfaces mid-call). If the next cut is a minor
 * (0.11.0) instead of a patch, the semver comparison still passes.
 * Erring HIGH is safe here: the fallback card self-hides when no
 * pending surface exists, so showing the fallback slot against a newer
 * assistant that never raises one costs nothing; erring LOW would hide
 * the card from assistants that can still raise it mid-call.
 *
 * Delete this gate — along with the voice-room connect card
 * (`use-active-connect-surface.ts` and the card slot in
 * `voice-room.tsx`) — once the minimum supported assistant is
 * >= MIN_VERSION.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.10";

/**
 * Returns `true` when the active assistant enforces non-interactive
 * voice turns (it can no longer raise `oauth_connect` or other UI
 * surfaces mid-call), so the voice room's fallback connect card can stay
 * hidden.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION` — on the
 * `false` branch the room keeps rendering the reachable connect card,
 * which any assistant understands (it self-hides with no pending
 * surface).
 */
export function useSupportsNoninteractiveVoiceTurns(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
