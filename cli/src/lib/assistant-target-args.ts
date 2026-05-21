export function parseAssistantTargetArg(
  args: string[],
  flagsWithValues: readonly string[] = [],
): string | undefined {
  const flagsWithValuesSet = new Set(flagsWithValues);
  const parts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flagsWithValuesSet.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    parts.push(arg);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}
