/**
 * Default `empty-response` plugin.
 *
 * Contributes a `stop` hook that re-queries the model when a turn yields with
 * no tool calls but came back empty (or as a provider refusal). The decision
 * logic lives in `./hooks/stop.ts`. Defaults register before user plugins, so
 * this runs at the front of the `stop` hook chain.
 */

import { type Plugin } from "../../types.js";
import stop from "./hooks/stop.js";
import pkg from "./package.json" with { type: "json" };

/** Singleton plugin — the registry rejects duplicate registrations by name. */
export const defaultEmptyResponsePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  hooks: {
    stop,
  },
};
