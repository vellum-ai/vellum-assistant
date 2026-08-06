/**
 * Backwards-compat gate: remote-web device pairing.
 *
 * Assistant `0.10.0` is the first version whose gateway serves the
 * remote-web pairing routes (`/v1/remote-web/pairing-challenge`,
 * `/v1/remote-web/pairing-verification`) that the settings "Pair a
 * device" card mints through. Against an older assistant the card
 * renders nothing rather than offering a button whose first POST fails.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.0";

/** `true` when the connected assistant serves the remote-web pairing routes. */
export function useSupportsRemoteWebPairing(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
