import type { BrowserMode } from "./cdp-client/types.js";

/**
 * Canonical browser-mode identifiers shared across parsing and status
 * reporting paths.
 */
export const BROWSER_MODE = {
  AUTO: "auto",
  EXTENSION: "extension",
  CDP_INSPECT: "cdp-inspect",
  LOCAL: "local",
} as const satisfies Record<string, BrowserMode>;
