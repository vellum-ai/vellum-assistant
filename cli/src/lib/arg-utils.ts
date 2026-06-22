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

/**
 * Strip `--<name> <value>` from argv and return the captured value.
 *
 * Mutates the input array so positional parsing downstream sees a clean shape.
 * Returns `undefined` if the flag is absent. Error-reports a missing value (and
 * exits) so the user gets a clear message rather than the flag being silently
 * swallowed as a positional.
 */
export function extractValueFlag(
  args: string[],
  name: string,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== `--${name}`) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("-")) {
      console.error(`Missing value for --${name} <value>`);
      process.exit(1);
    }
    args.splice(i, 2);
    return value;
  }
  return undefined;
}

/**
 * Strip `--assistant <name>` from argv and return the captured value.
 *
 * Mutates the input array so positional parsing downstream sees a clean shape
 * (subcommand + key + value). Returns `undefined` if the flag is absent.
 * Error-reports a missing value so the user gets a clear message rather than
 * the flag being silently swallowed as a positional. (Kept distinct from
 * {@link extractValueFlag} only for its `<name>` wording in the error string.)
 */
export function extractAssistantFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--assistant") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("-")) {
      console.error("Missing value for --assistant <name>");
      process.exit(1);
    }
    args.splice(i, 2);
    return value;
  }
  return undefined;
}
