/**
 * Terminal capability detection module.
 *
 * Detects color support, unicode availability, and terminal dimensions
 * by inspecting TERM, COLORTERM, NO_COLOR, and related environment
 * variables. Designed to enable graceful degradation on dumb terminals
 * and constrained environments (e.g. SSH to a Raspberry Pi).
 */

export type ColorLevel = "none" | "basic" | "256" | "truecolor";

export interface TerminalCapabilities {
  /** Detected color support level */
  colorLevel: ColorLevel;
  /** Whether the terminal likely supports unicode glyphs */
  unicodeSupported: boolean;
  /** Current terminal width in columns (falls back to 80) */
  columns: number;
  /** Current terminal rows (falls back to 24) */
  rows: number;
  /** True when TERM=dumb — indicates a terminal with no cursor addressing */
  isDumb: boolean;
}

/**
 * Detect the color support level from environment variables.
 *
 * Precedence (highest to lowest):
 *   1. NO_COLOR or TERM=dumb  → "none"
 *   2. COLORTERM=truecolor / 24bit → "truecolor"
 *   3. TERM contains "256color" → "256"
 *   4. Any other interactive terminal → "basic"
 *   5. Non-TTY → "none"
 */
function detectColorLevel(env: NodeJS.ProcessEnv): ColorLevel {
  // NO_COLOR spec: https://no-color.org/
  if (env.NO_COLOR !== undefined) return "none";

  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";

  const colorterm = (env.COLORTERM ?? "").toLowerCase();

  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (term.includes("256color")) return "256";

  // If we have a TERM value at all, assume basic color support
  if (term.length > 0) return "basic";

  // Fallback: if stdout is a TTY, assume basic
  if (process.stdout.isTTY) return "basic";

  return "none";
}

/**
 * Heuristic for unicode support.
 *
 * Checks LANG / LC_ALL / LC_CTYPE for UTF-8. Falls back to false on
 * dumb terminals since many dumb terminal emulators lack glyph support.
 */
function detectUnicode(env: NodeJS.ProcessEnv, isDumb: boolean): boolean {
  if (isDumb) return false;

  const locale = (env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "").toLowerCase();

  return locale.includes("utf-8") || locale.includes("utf8");
}

/**
 * Detect terminal capabilities from the current process environment.
 *
 * The result is a plain object (no singletons) so tests can call this
 * with a mocked env if needed.
 */
export function detectCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): TerminalCapabilities {
  const term = (env.TERM ?? "").toLowerCase();
  const isDumb = term === "dumb";
  const colorLevel = detectColorLevel(env);
  const unicodeSupported = detectUnicode(env, isDumb);

  return {
    colorLevel,
    unicodeSupported,
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    isDumb,
  };
}

/** Lazily-cached capabilities for the current process. */
let _cached: TerminalCapabilities | undefined;

/**
 * Return (and cache) the terminal capabilities for the running process.
 *
 * Safe to call multiple times — subsequent calls return the cached
 * result. Use `detectCapabilities()` directly if you need a fresh read
 * (e.g. after a terminal resize).
 */
export function getTerminalCapabilities(): TerminalCapabilities {
  if (!_cached) {
    _cached = detectCapabilities();
  }
  return _cached;
}

/**
 * Return `fancy` when unicode is supported, otherwise `fallback`.
 *
 * Example: `unicodeOrFallback("🟢", "[ok]")`
 */
export function unicodeOrFallback(fancy: string, fallback: string): string {
  return getTerminalCapabilities().unicodeSupported ? fancy : fallback;
}
