/**
 * Backwards-compat gate: `vellum` as a web-search provider value.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. Daemons older than MIN_VERSION validate
 * `services["web-search"].provider` against an enum that has no `vellum`
 * member, so writing it can make the daemon's next config reload reject or
 * reset the web-search section while the UI reports a successful save.
 *
 * On the `false` branch the card still offers Vellum but persists the
 * selection the way the legacy Managed toggle did: `{ mode: "managed" }`
 * with no provider, letting the daemon's deep-merge keep whatever provider
 * is already stored. The legacy read bridge then renders that config as
 * Vellum again, so the choice round-trips. (A fresh old daemon with no
 * stored web-search provider fills its schema default,
 * `inference-provider-native`, which renders as Provider Native — a
 * cosmetic snap that only affects old daemons and disappears once they
 * upgrade.)
 *
 * MIN_VERSION targets 0.10.12 — the first release whose search-provider
 * catalog (and config-schema enum) includes `vellum` (#38677).
 */
import { assistantSupports } from "./utils";

export const MIN_VERSION = "0.10.12";

/**
 * Snapshot gate for the save path: whether the active assistant accepts
 * `provider: "vellum"` in the web-search config. Callers should
 * `await whenAssistantVersionKnown()` before reading.
 */
export function supportsWebSearchVellumProvider(): boolean {
  return assistantSupports(MIN_VERSION);
}
