/**
 * Backwards-compat gate: the wire payload for Vellum-picker profiles.
 *
 * Daemons at `MIN_VERSION` and later store and dispatch
 * `provider: "vellum"` profiles (the routing identity: the managed
 * upstream derives from the model per-request, no connection binding).
 * Older daemons reject the value at the profile write route, so the
 * editor writes the legacy wire shape instead — the model's managed
 * upstream as `provider`, bound to the provider-agnostic `vellum`
 * connection. The UI is identical either way; only the payload differs.
 *
 * Async: this gates a WRITE path, and the legacy fallback persists a
 * shape newer daemons merely tolerate — so the check awaits
 * `whenAssistantVersionKnown()` rather than snapshotting the
 * conservative false-on-unknown default (see the write-path note on
 * that helper).
 *
 * Owner-scoped: the wait can resolve after an assistant switch, in
 * which case the store holds a different assistant's version than the
 * one the save targets. When `ownerAssistantId` is supplied, the
 * hydrated identity must belong to exactly that assistant — an
 * un-owned identity (a writer that omitted the owner tag) gates to the
 * legacy payload, the only shape that is safe on every daemon. A null
 * owner (caller has no write-target id) accepts any hydrated identity.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { assistantSupports, whenAssistantVersionKnown } from "./utils";

const MIN_VERSION = "0.10.12";

export async function assistantSupportsVellumProviderProfiles(
  ownerAssistantId?: string | null,
  versionWaitTimeoutMs?: number,
): Promise<boolean> {
  await whenAssistantVersionKnown(versionWaitTimeoutMs);
  const hydratedAssistantId =
    useAssistantIdentityStore.getState().assistantId;
  if (ownerAssistantId != null && hydratedAssistantId !== ownerAssistantId) {
    return false;
  }
  return assistantSupports(MIN_VERSION);
}
