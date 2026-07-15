/**
 * Backwards-compat gate: non-interactive voice turns.
 *
 * This is the canonical writeup for the voice room's fallback OAuth
 * connect card — the hook site and card slot in `voice-room.tsx` and the
 * suite in `voice-room.test.tsx` point back here.
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
 * MIN_VERSION is 0.11.0. v0.10.9 was released 2026-07-14 without the
 * daemon-side `supportsDynamicUi: false` enforcement, and a later 0.10.x
 * patch could be cut without it too; 0.11.0 is the first release
 * GUARANTEED to contain it (the other in-flight gates in this directory
 * pin the same 0.11.0). The asymmetry makes erring HIGH free: if the
 * enforcement happens to ship in an earlier patch, the only cost is the
 * fallback card remaining available for that patch's assistants — it
 * self-hides whenever no pending surface exists, and such an assistant
 * never raises one mid-call. Gating LOWER would risk hiding the card
 * from assistants that can still raise surfaces mid-call — the exact
 * stall the card exists to prevent.
 *
 * The gate is scoped to the assistant that owns the live voice session:
 * the identity store records which assistant its version was fetched for
 * (written atomically with the version in the same store update), and
 * the gate reads `true` only when that owner is the session's assistant.
 * A mismatch — e.g. the identity store re-hydrating for a different
 * assistant mid-call — conservatively reads as "not supported", keeping
 * the fallback card available.
 *
 * Accepted edge: an assistant at or above MIN_VERSION can still raise an
 * `oauth_connect` surface in a TEXT turn just before the call starts,
 * and the gate hides the room's copy of that card too. Intended: with
 * the surface voice-resume machinery gone, completing it mid-call would
 * produce an unspoken text-path reply, and the transcript's own card is
 * reachable again the moment the call ends.
 *
 * Delete this gate — along with the voice-room connect card
 * (`use-active-connect-surface.ts` and the card slot in
 * `voice-room.tsx`) — once the minimum supported assistant is
 * >= MIN_VERSION.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.0";

/**
 * Returns `true` when the assistant that owns the live voice session
 * (`sessionAssistantId`) enforces non-interactive voice turns (it can no
 * longer raise `oauth_connect` or other UI surfaces mid-call), so the
 * voice room's fallback connect card can stay hidden. Both the version
 * and its owner are read from the identity store — a single atomic
 * snapshot — so the version can never be checked against a different
 * assistant's session, even transiently during an assistant switch.
 *
 * Returns `false` when the session's assistant is null/undefined, when
 * the identity store's version was fetched for a different assistant,
 * while no version has hydrated yet, when the version is unparseable, or
 * when it falls below `MIN_VERSION` — on the `false` branch the room
 * keeps rendering the reachable connect card, which any assistant
 * understands (it self-hides with no pending surface).
 */
export function useSupportsNoninteractiveVoiceTurns(
  sessionAssistantId: string | null | undefined,
): boolean {
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const versionSupported = useAssistantSupports(MIN_VERSION);
  return (
    versionSupported &&
    sessionAssistantId != null &&
    sessionAssistantId === identityAssistantId
  );
}
