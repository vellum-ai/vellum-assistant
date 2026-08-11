/**
 * Backwards-compat gate: the wire payload for entry-bound profiles.
 *
 * Daemons at `MIN_VERSION` and later store and dispatch profiles whose
 * `provider` holds a connection (entry) name — the entries model: the
 * binding lives IN the provider value, a bare catalog id means the kind's
 * default entry, and `provider_connection` is never written. Older daemons
 * reject entry names at the profile write route, so the editor writes the
 * legacy shape instead: the vendor as `provider` plus the entry name as
 * `provider_connection`. The UI is identical either way.
 *
 * RELEASE-CUT: verify the first release carrying migration
 * 145-collapse-profile-bindings-to-entries is in fact `MIN_VERSION`.
 *
 * Async and owner-scoped for the same reasons as
 * `vellum-profile-provider.ts` (the PR 14 precedent): this gates a WRITE
 * path whose legacy fallback newer daemons merely tolerate, so the check
 * awaits a hydrated version, and a supplied `ownerAssistantId` must match
 * the hydrated identity exactly — an un-owned or mismatched identity gates
 * to the legacy payload, the only shape safe on every daemon.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { assistantSupports, whenAssistantVersionKnown } from "./utils";

const MIN_VERSION = "0.11.4";

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
