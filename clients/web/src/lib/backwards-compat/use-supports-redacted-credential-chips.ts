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
 * The gate is bound to the **transcript owner**: the identity store records
 * which assistant its version was fetched for (written atomically with the
 * version in the same store update), and chips enable only when that owner
 * is the transcript's owner. Comparing against the identity store's own
 * `assistantId` — rather than `activeAssistantId` from the
 * resolved-assistants store — keeps the check race-free on assistant
 * switch: the two stores update at different times, so a cross-store
 * pairing could briefly validate an old-daemon transcript against the
 * previous assistant's version. Conservative on unknown.
 *
 * MIN_VERSION targets 0.10.10 — the release that ships daemon-side sentinel
 * minting and neutralization. On the `false` branch callers leave sentinel
 * text as plain literal text.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.10.10";

/**
 * Returns `true` when the transcript owned by `transcriptAssistantId` may
 * upgrade sentinel text into reveal chips: the identity store's hydrated
 * version must belong to that same assistant and meet `MIN_VERSION`. Both
 * facts are read from the identity store — a single atomic snapshot — so
 * the version can never be checked against a different assistant's
 * transcript, even transiently during an assistant switch.
 *
 * Returns `false` when the owner is null/undefined, when the identity
 * store's version was fetched for a different assistant, while no version
 * has hydrated yet, when the version is unparseable, or when it falls
 * below `MIN_VERSION` — callers render sentinel-shaped text as plain text
 * on the `false` branch.
 */
export function useSupportsRedactedCredentialChips(
  transcriptAssistantId: string | null | undefined,
): boolean {
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const versionSupported = useAssistantSupports(MIN_VERSION);
  return (
    versionSupported &&
    transcriptAssistantId != null &&
    transcriptAssistantId === identityAssistantId
  );
}
