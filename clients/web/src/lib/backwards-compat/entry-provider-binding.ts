/**
 * Backwards-compat gate: the wire payload for entry-bound profiles.
 *
 * Daemons at `MIN_VERSION` and later store and dispatch profiles whose
 * `provider` holds a connection (entry) name (the entries model: the
 * binding lives IN the provider value, a bare catalog id means the kind's
 * default entry, and `provider_connection` is never written). Older daemons
 * reject entry names at the profile write route, so the editor writes the
 * legacy shape instead: the vendor as `provider` plus the entry name as
 * `provider_connection`. The UI is identical either way.
 *
 * The floor is the dev version of ef1568cea2, the assistant commit that
 * landed the entries collapse (migration 145) and entry-name writes.
 * Base-version comparison means every later release satisfies it no
 * matter how it is numbered, and dev builds cut after that commit light
 * up immediately; a hotfix numbered like the next release but cut
 * without the commit does not (see BACKWARDS_COMPAT.md, "Prefer a dev
 * floor to a predicted release number").
 *
 * Async and owner-scoped for the same reasons as
 * `vellum-profile-provider.ts` (the PR 14 precedent): this gates a WRITE
 * path whose legacy fallback newer daemons merely tolerate, so the check
 * awaits a hydrated version, and a supplied `ownerAssistantId` must match
 * the hydrated identity exactly; an un-owned or mismatched identity gates
 * to the legacy payload, the only shape safe on every daemon.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { assistantSupports, whenAssistantVersionKnown } from "./utils";

const MIN_VERSION = "0.11.3-dev.202608102358.ef1568c";

export async function assistantSupportsEntryProviderBinding(
  ownerAssistantId?: string | null,
  versionWaitTimeoutMs?: number,
): Promise<boolean> {
  await whenAssistantVersionKnown(versionWaitTimeoutMs);
  const hydratedAssistantId = useAssistantIdentityStore.getState().assistantId;
  if (ownerAssistantId != null && hydratedAssistantId !== ownerAssistantId) {
    return false;
  }
  return assistantSupports(MIN_VERSION);
}
