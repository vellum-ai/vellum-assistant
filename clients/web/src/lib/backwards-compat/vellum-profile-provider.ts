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
 * that helper). After the bounded wait, a still-unknown version gates
 * to the legacy payload, which every daemon accepts.
 */
import { assistantSupports, whenAssistantVersionKnown } from "./utils";

const MIN_VERSION = "0.10.12";

export async function assistantSupportsVellumProviderProfiles(
  versionWaitTimeoutMs?: number,
): Promise<boolean> {
  await whenAssistantVersionKnown(versionWaitTimeoutMs);
  return assistantSupports(MIN_VERSION);
}
