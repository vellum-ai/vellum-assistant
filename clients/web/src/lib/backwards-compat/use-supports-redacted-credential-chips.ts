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
 * The gate is bound to the **transcript owner**, not the globally active
 * assistant: the identity store's version describes only the active
 * assistant (the `/identity` endpoint exists for the live connection alone),
 * so a transcript owned by any other assistant has no trustworthy version
 * and must stay chip-free. Conservative on unknown.
 *
 * MIN_VERSION targets 0.11.0 — the release that ships daemon-side sentinel
 * minting and neutralization. On the `false` branch callers leave sentinel
 * text as plain literal text.
 */
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.11.0";

/**
 * Returns `true` when the transcript owned by `transcriptAssistantId` may
 * upgrade sentinel text into reveal chips: the owner must be the active
 * assistant (the only one whose live version the identity store reports)
 * and that version must meet `MIN_VERSION`. Subscribes to both stores, so
 * chips light up when the active assistant or its version changes.
 *
 * Returns `false` when the owner is null/undefined, when it is not the
 * active assistant, while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION` — callers
 * render sentinel-shaped text as plain text on the `false` branch.
 */
export function useSupportsRedactedCredentialChips(
  transcriptAssistantId: string | null | undefined,
): boolean {
  const activeAssistantId =
    useResolvedAssistantsStore.use.activeAssistantId();
  const versionSupported = useAssistantSupports(MIN_VERSION);
  return (
    versionSupported &&
    transcriptAssistantId != null &&
    transcriptAssistantId === activeAssistantId
  );
}
