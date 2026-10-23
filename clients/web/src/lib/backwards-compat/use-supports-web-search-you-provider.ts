/**
 * Backwards-compat gate: `you` (You.com) as a web-search provider value.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. Daemons older than MIN_VERSION validate
 * `services["web-search"].provider` against an enum that has no `you`
 * member, so writing it can make the daemon's next config reload reject or
 * reset the web-search section while the UI reports a successful save.
 *
 * Old behavior (< MIN_VERSION): the settings picker hides You.com and the
 * save path refuses to write `provider: "you"`.
 * New behavior (>= MIN_VERSION): You.com is offered and saved like any other
 * BYOK provider (key optional).
 *
 * MIN_VERSION is the first release after 0.12.6, the version this change was
 * built against. Replace it with the dev floor of the assistant-side commit
 * once that lands on main (see docs/BACKWARDS_COMPAT.md).
 */
import { assistantSupports, useAssistantSupports } from "./utils";

export const MIN_VERSION = "0.12.7";

/** Render gate for the provider picker. */
export function useSupportsWebSearchYouProvider(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Snapshot gate for the save path: whether the active assistant accepts
 * `provider: "you"` in the web-search config. Callers should
 * `await whenAssistantVersionKnown()` before reading.
 */
export function supportsWebSearchYouProvider(): boolean {
  return assistantSupports(MIN_VERSION);
}
