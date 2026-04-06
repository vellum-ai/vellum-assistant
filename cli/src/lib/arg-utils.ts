/** Extract a named flag's value from an arg list, returning [value, remaining]. */
export function extractFlag(
  args: string[],
  flag: string,
): [string | undefined, string[]] {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return [undefined, args.filter((a) => a !== flag)];
  }
  const value = args[idx + 1]!;
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return [value, remaining];
}
