/**
 * Backwards-compat gate: the live-voice entry point.
 *
 * The composer's live-voice button used to be gated on the `voice-mode`
 * assistant flag, which doubled as a de-facto version gate: an assistant too
 * old to declare the flag never reported it on, and undeclared flags fail
 * closed, so the button stayed hidden. Retiring the flag at GA removed that
 * gate, so this one replaces it explicitly.
 *
 * MIN_VERSION is 0.10.12 — the first release containing
 * `POST /v1/live-voice/preflight` (PR #38463, merged 2026-07-21). Older
 * assistants 404 that route; `preflightLiveVoice()` maps the 404 to `null`
 * and the composer deliberately fails OPEN on `null`, so without this gate a
 * click sails past the readiness check into `/v1/live-voice` and surfaces a
 * raw connection failure instead of the "configure voice" notice. The gate is
 * load-bearing because one CDN-served bundle serves self-hosted assistants of
 * arbitrary age.
 *
 * Gating on the preflight route rather than the much older `/v1/live-voice`
 * WebSocket shell (0.7.0) is the conservative choice, and it costs nothing:
 * every assistant below 0.10.12 was already hidden from the button by the
 * flag's fail-closed default, so this preserves exactly the pre-GA behavior
 * for them rather than newly exposing a half-working path.
 *
 * - Old behavior (< MIN_VERSION): no live-voice entry point; the send slot
 *   falls back to the disabled send arrow, and dictation is unaffected.
 * - New behavior (>= MIN_VERSION): the entry point renders and the preflight
 *   verdict decides whether the room opens.
 *
 * Scoped to the owning assistant via `useAssistantScopedSupports` — see its
 * JSDoc in `./utils.ts` for the atomic version+owner snapshot and
 * conservative unknown/mismatch semantics — so a version fetched for one
 * assistant never authorizes another's routes mid-switch. A render hook (not
 * the `assistantSupports` snapshot) so the button appears the moment the
 * version hydrates.
 *
 * Deliberately NOT consulted once a session is live: entry already gated it,
 * and the voice bar / room must survive a mid-session eligibility drop so the
 * ✕ stays reachable until teardown completes.
 */
import {
  assistantScopedSupports,
  useAssistantScopedSupports,
} from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.12";

/**
 * Returns `true` when the assistant that owns the composer
 * (`ownerAssistantId`) is new enough to serve the live-voice preflight route,
 * so the voice entry point can render. Conservative (`false`) until the
 * scoped version hydrates and on any owner mismatch, which hides the entry
 * point — a state every assistant understands.
 */
export function useSupportsLiveVoice(
  ownerAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, ownerAssistantId);
}

/**
 * Non-hook variant of {@link useSupportsLiveVoice} for imperative callers —
 * the start-voice deep link, which starts a session from a bus handler rather
 * than a render. Same conservative semantics, read off a `getState()` snapshot.
 *
 * Callers must have a *resolved* version in hand: the snapshot collapses
 * "unknown" and "known-old" into `false`, so a caller running before the
 * identity fetch lands has to await `whenAssistantVersionKnown()` first (see
 * `start-voice-request.ts`).
 */
export function supportsLiveVoice(
  ownerAssistantId: string | null | undefined,
): ownerAssistantId is string {
  return assistantScopedSupports(MIN_VERSION, ownerAssistantId);
}
