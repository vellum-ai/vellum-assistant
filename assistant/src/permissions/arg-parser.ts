import type { ArgSchema, ParsedArgs, PositionalDesc } from "./risk-types.js";

/**
 * Parse a command's arguments according to an {@link ArgSchema}.
 *
 * Classifies each token as a flag, positional, or path argument. The
 * resulting {@link ParsedArgs} is consumed by downstream path-resolution
 * and sandbox-policy checks.
 */
export function parseArgs(args: string[], schema: ArgSchema): ParsedArgs {
  const valueFlagSet = new Set(schema.valueFlags);
  const pathFlagSet = new Set(
    schema.pathFlags ? Object.keys(schema.pathFlags) : [],
  );

  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const pathArgs: string[] = [];
  let sawDoubleDash = false;

  let i = 0;
  while (i < args.length) {
    const token = args[i]!;

    // After `--`, everything is positional.
    if (sawDoubleDash) {
      positionals.push(token);
      addIfPath(token, positionals.length - 1, schema.positionals, pathArgs);
      i++;
      continue;
    }

    // Double-dash terminator.
    if (token === "--" && schema.respectsDoubleDash !== false) {
      sawDoubleDash = true;
      i++;
      continue;
    }

    // Value-consuming flag: consume next token as the flag's value.
    if (token.startsWith("-") && valueFlagSet.has(token)) {
      const nextIndex = i + 1;
      if (nextIndex < args.length) {
        const value = args[nextIndex]!;
        flags.set(token, value);
        if (pathFlagSet.has(token)) {
          pathArgs.push(value);
        }
        i += 2;
      } else {
        // Flag at end of args with no next token — treat as boolean.
        flags.set(token, true);
        i++;
      }
      continue;
    }

    // Boolean flag (starts with `-` but not a value-consuming flag).
    if (token.startsWith("-")) {
      flags.set(token, true);
      i++;
      continue;
    }

    // Positional argument.
    positionals.push(token);
    addIfPath(token, positionals.length - 1, schema.positionals, pathArgs);
    i++;
  }

  return { flags, positionals, pathArgs, sawDoubleDash };
}

/**
 * Determine whether a positional at the given index is a path and, if so,
 * add it to `pathArgs`.
 */
function addIfPath(
  token: string,
  index: number,
  positionalsDef: ArgSchema["positionals"],
  pathArgs: string[],
): void {
  if (positionalsDef === undefined || positionalsDef === "paths") {
    // Default: all positionals are paths.
    pathArgs.push(token);
    return;
  }

  if (positionalsDef === "none") {
    // Explicitly not paths.
    return;
  }

  // Array of PositionalDesc — look up by index.
  const descs: PositionalDesc[] = positionalsDef;

  // Find the applicable descriptor: either the one at this index, or a
  // previous `rest: true` descriptor that covers all subsequent positions.
  let desc: PositionalDesc | undefined;

  if (index < descs.length) {
    desc = descs[index];
  } else {
    // Look backwards for the last `rest: true` descriptor.
    for (let j = descs.length - 1; j >= 0; j--) {
      if (descs[j]!.rest) {
        desc = descs[j];
        break;
      }
    }
  }

  if (desc) {
    if (desc.role === "path") {
      pathArgs.push(token);
    }
    // Other roles (pattern, script, value, command) → not a path.
  } else {
    // No descriptor and no rest — conservative default: treat as path.
    pathArgs.push(token);
  }
}
