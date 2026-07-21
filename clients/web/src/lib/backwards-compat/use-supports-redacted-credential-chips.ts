/**
 * Backwards-compat gate: redacted-credential chips in chat transcripts.
 *
 * The daemon persists detected secrets as structured sentinels
 * (`〔redacted:TYPE:SERVICE:FIELD〕`) and — critically — neutralizes any
 * sentinel-shaped text that it did not mint itself, at every boundary
 * (persist, history render, live stream). The web app upgrades genuine
 * sentinels into interactive reveal chips.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. An older daemon performs no neutralization, so
 * against it any text that merely *looks* like a sentinel (pasted, echoed,
 * or adversarially crafted) would chip-ify in the transcript and present a
 * forged reveal affordance. Older daemons also never mint genuine sentinels,
 * so there is nothing legitimate to render — keep chips off entirely until
 * the assistant that owns the transcript is known to neutralize.
 *
 * The gate is bound to the **transcript owner** via
 * `useAssistantScopedSupports` — see its JSDoc in `./utils.ts` for the
 * atomic version+owner snapshot and conservative-on-mismatch semantics.
 *
 * MIN_VERSION targets 0.10.10 — the release that ships daemon-side sentinel
 * minting and neutralization. On the `false` branch callers leave sentinel
 * text as plain literal text.
 */
import { useAssistantScopedSupports } from "./utils";

export const MIN_VERSION = "0.10.10";

/**
 * Returns `true` when the transcript owned by `transcriptAssistantId` may
 * upgrade sentinel text into reveal chips: the identity store's hydrated
 * version must belong to that same assistant and meet `MIN_VERSION`.
 *
 * On the `false` branch — below `MIN_VERSION`, or any of
 * `useAssistantScopedSupports`'s conservative unknown/mismatch cases —
 * callers render sentinel-shaped text as plain text.
 */
export function useSupportsRedactedCredentialChips(
  transcriptAssistantId: string | null | undefined,
): boolean {
  return useAssistantScopedSupports(MIN_VERSION, transcriptAssistantId);
}
