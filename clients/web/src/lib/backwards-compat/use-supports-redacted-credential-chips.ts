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
 * the active assistant is known to neutralize. Conservative on unknown.
 *
 * MIN_VERSION targets 0.11.0 — the release that ships daemon-side sentinel
 * minting and neutralization. On the `false` branch callers leave sentinel
 * text as plain literal text.
 */
import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.0";

/**
 * Returns `true` when the active assistant mints redacted-credential
 * sentinels and neutralizes forged ones, so transcript render sites may
 * upgrade sentinel text into reveal chips. Subscribes to the identity store,
 * so chips light up when the assistant version crosses `MIN_VERSION`.
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION` — callers
 * render sentinel-shaped text as plain text on the `false` branch.
 */
export function useSupportsRedactedCredentialChips(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
