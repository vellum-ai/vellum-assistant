/**
 * Backwards-compat gate: `vellum` as an image-generation provider value.
 *
 * The web app always serves the latest bundle, but the assistant can be any
 * locally-installed version. Daemons older than MIN_VERSION validate
 * `services["image-generation"].provider` against an enum that has no
 * `vellum` member, so writing it can make the daemon's next config reload
 * reject or reset the image-generation section while the UI reports a
 * successful save.
 *
 * On the `false` branch the card persists a Vellum selection the way the
 * legacy Managed toggle did: `{ mode: "managed" }` with no provider. The
 * legacy read bridge renders that config as Vellum again, so the choice
 * round-trips.
 *
 * MIN_VERSION targets 0.11.0: the first release whose image-generation
 * config enum includes `vellum` (#39109 merged after the 0.10.12 cut).
 */
import { assistantSupports } from "./utils";

export const MIN_VERSION = "0.11.0";

/**
 * Snapshot gate for the save path: whether the active assistant accepts
 * `provider: "vellum"` in the image-generation config. Callers should
 * `await whenAssistantVersionKnown()` before reading.
 */
export function supportsImageGenVellumProvider(): boolean {
  return assistantSupports(MIN_VERSION);
}
