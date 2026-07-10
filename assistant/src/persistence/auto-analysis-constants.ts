/**
 * Sentinel value for the `source` column of auto-analysis conversations.
 * The auto-analysis feature is retired, but rows with this source persist
 * on existing installs — consumers use it to keep those legacy rows
 * rendered correctly (feed display labels) and excluded from memory
 * extraction and context search.
 */
export const AUTO_ANALYSIS_SOURCE = "auto-analysis";
