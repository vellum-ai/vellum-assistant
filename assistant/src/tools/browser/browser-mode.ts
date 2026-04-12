/**
 * Normalization helper for the `browser_mode` tool input parameter.
 *
 * Canonical values map directly to {@link CdpClientKind}:
 *   - `auto`        -- let the factory pick the best backend (default)
 *   - `extension`   -- force the Chrome extension transport
 *   - `cdp-inspect` -- force the CDP inspect/debugger transport
 *   - `local`       -- force the Playwright-managed local browser
 *
 * Aliases are accepted and normalized to their canonical form:
 *   - `cdp-debugger` -> `cdp-inspect`
 *   - `playwright`   -> `local`
 */

/** Canonical browser mode values. */
export type BrowserMode = "auto" | "extension" | "cdp-inspect" | "local";

/** All accepted values (canonical + aliases). */
const ALIAS_MAP: Record<string, BrowserMode> = {
  auto: "auto",
  extension: "extension",
  "cdp-inspect": "cdp-inspect",
  "cdp-debugger": "cdp-inspect",
  local: "local",
  playwright: "local",
};

/** Ordered list of accepted values for error messages. */
const ACCEPTED_VALUES = Object.keys(ALIAS_MAP);

/**
 * Human-readable alias mapping for error messages.
 * Only includes entries where the alias differs from the canonical value.
 */
const ALIAS_DISPLAY: Record<string, string> = {
  "cdp-debugger": "cdp-inspect",
  playwright: "local",
};

export interface NormalizeBrowserModeResult {
  /** The normalized canonical mode. */
  mode: BrowserMode;
}

export interface NormalizeBrowserModeError {
  /** Deterministic error message describing the invalid value. */
  error: string;
}

/**
 * Normalize a raw `browser_mode` input value to a canonical {@link BrowserMode}.
 *
 * - `undefined` / `null` / empty string -> `{ mode: "auto" }`
 * - Valid canonical value or alias       -> `{ mode: <canonical> }`
 * - Invalid value                        -> `{ error: "..." }` with accepted list and alias mapping
 */
export function normalizeBrowserMode(
  raw: unknown,
): NormalizeBrowserModeResult | NormalizeBrowserModeError {
  if (raw === undefined || raw === null || raw === "") {
    return { mode: "auto" };
  }

  if (typeof raw !== "string") {
    return buildError(String(raw));
  }

  const lower = raw.toLowerCase().trim();
  const canonical = ALIAS_MAP[lower];

  if (canonical !== undefined) {
    return { mode: canonical };
  }

  return buildError(raw);
}

function buildError(value: string): NormalizeBrowserModeError {
  const aliasHints = Object.entries(ALIAS_DISPLAY)
    .map(([alias, canonical]) => `${alias}->${canonical}`)
    .join(", ");

  return {
    error:
      `Invalid browser_mode "${value}". ` +
      `Accepted values: ${ACCEPTED_VALUES.join(", ")}. ` +
      `Aliases: ${aliasHints}.`,
  };
}
