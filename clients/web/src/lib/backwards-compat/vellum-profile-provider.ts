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
 * NOTE: snapshot-based (`assistantSupports`) — the editor's save handler
 * runs outside render. Unknown/unparseable versions gate to the legacy
 * payload, which every daemon accepts.
 */
import { assistantSupports } from "./utils";

const MIN_VERSION = "0.10.12";

export function assistantSupportsVellumProviderProfiles(): boolean {
  return assistantSupports(MIN_VERSION);
}
