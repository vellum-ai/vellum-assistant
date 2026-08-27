/**
 * Backwards-compat gate: Discord's in-product credential form.
 *
 * The Discord config routes (GET/POST/DELETE `integrations/discord/config`)
 * are newer than the readiness probe, so a daemon can show the Discord row
 * while having nowhere for the manual form to save: the wizard's connect
 * step would 404. Below this version the row still renders and guided setup
 * still works (the setup skill stores the token through the CLI); only the
 * manual credential form is withheld.
 *
 * A version gate rather than a feature flag: it resolves as daemons update
 * and leaves nothing to clean up. See `docs/BACKWARDS_COMPAT.md`.
 */
import { useAssistantSupports } from "./utils";

/** First build that serves the Discord config routes. */
export const MIN_VERSION = "0.11.5-dev.202608252008.65007aa";

/** Whether this assistant can store a Discord bot token over HTTP. */
export function useSupportsDiscordConfig(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
