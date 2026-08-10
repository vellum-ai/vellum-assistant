/**
 * Guard for callers still passing the line-based `offset`/`limit` read
 * arguments. The tool schemas are loose, so those keys parse and are then
 * dropped, which would silently serve the start of the file to a caller that
 * asked to page into the middle of it.
 *
 * There is no safe translation: `offset` counted lines and `start_index`
 * counts characters, so mapping one onto the other would read the wrong
 * region rather than fail. Naming the rename lets the caller correct itself.
 */
export function legacyReadArgsError(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const usesLegacy = input.offset !== undefined || input.limit !== undefined;
  const usesCurrent =
    input.start_index !== undefined || input.max_chars !== undefined;
  if (!usesLegacy || usesCurrent) {
    return undefined;
  }
  return `Error: ${toolName} no longer takes \`offset\`/\`limit\` (lines). Use \`start_index\` (0-indexed characters) and \`max_chars\` instead.`;
}
