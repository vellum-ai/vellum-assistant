/** Names that survive a shell verbatim; everything else has to be quoted. */
const SHELL_SAFE_ARG = /^[A-Za-z0-9._-]+$/;

/**
 * One free-form value as a single shell word, for commands printed for the
 * user to paste. Assistant names and ids are only checked for path separators
 * when they are created, so `Bob&Alice` and `My $team` both reach here.
 *
 * Single quotes are the only ones that also neutralize `$`, backticks and
 * backslashes, and an embedded one closes the quote, escapes itself, and
 * reopens.
 */
export function shellArg(value: string): string {
  return SHELL_SAFE_ARG.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}
