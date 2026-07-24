import { z } from "zod";

/**
 * User-defined route (`/x/*`) execution configuration.
 *
 * By default, route handlers run inline on the daemon's event loop. Enabling the
 * route host runs each handler in a dedicated subprocess instead, so a handler
 * that blocks synchronously pins only the host process (the daemon stays
 * responsive) and a wedged handler can be reclaimed with a hard kill.
 */
export const UserRoutesConfigSchema = z
  .object({
    host: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Run user-defined /x/* route handlers in a dedicated subprocess (the route host) instead of inline on the daemon's event loop. When on, a handler that blocks synchronously pins only the host process and a wedged handler is reclaimed with a hard kill; the next request respawns the host. Default false (in-band execution).",
          ),
      })
      .default({ enabled: false })
      .describe("Route host subprocess configuration."),
  })
  .describe("User-defined route (/x/*) execution configuration.");

export type UserRoutesConfig = z.infer<typeof UserRoutesConfigSchema>;
