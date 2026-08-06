/**
 * Stripping of terminal escape sequences and control characters from
 * untrusted strings before they reach a terminal or notification copy.
 *
 * One pattern serves every call site so coverage cannot drift between
 * hand-rolled copies. CSI sequences carry the full parameter and
 * intermediate byte ranges; OSC sequences match through their BEL/ST
 * terminator, with the terminator optional so an unterminated sequence
 * cannot smuggle its body past the strip.
 */

/**
 * Well-formed ANSI escape sequences: CSI (`ESC [ params intermediates final`,
 * covering colors, cursor moves, erase) and OSC (`ESC ] payload BEL|ST`,
 * covering window-title writes and hyperlinks).
 */
const ANSI_SEQUENCE_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/**
 * Runs of C0/C1 control characters, including DEL and any bare ESC left by a
 * malformed sequence. `\r` and `\n` are C0, so this also flattens newlines.
 */
const CONTROL_CHAR_RUN_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Remove ANSI CSI/OSC escape sequences, leaving other control characters
 * (newlines, tabs) intact. For multi-line text whose line structure matters.
 */
export function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_SEQUENCE_RE, "");
}

/**
 * Remove ANSI CSI/OSC escape sequences, then replace every remaining run of
 * C0/C1 control characters with `replacement` (removed by default). For
 * single-line rendering where no control character may survive.
 */
export function stripAnsiAndControlChars(
  value: string,
  replacement = "",
): string {
  return stripAnsiSequences(value).replace(CONTROL_CHAR_RUN_RE, replacement);
}
