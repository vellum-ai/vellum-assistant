#!/usr/bin/env bun

/**
 * Shared utilities for outlook scripts.
 * Provides CLI argument parsing, JSON output helpers, and common patterns.
 */

/** Parse `--key value` and `--flag` CLI arguments. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }
  return result;
}

/** Write JSON to stdout. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/** Write `{ ok: false, error: message }` to stdout and exit. */
export function printError(message: string): void {
  printJson({ ok: false, error: message });
  process.exit(1);
}

/** Write `{ ok: true, data }` to stdout. */
export function ok(data: unknown): void {
  printJson({ ok: true, data });
}

/** Extract a required string argument or call `printError`. */
export function requireArg(
  args: Record<string, string | boolean>,
  name: string,
): string {
  const value = args[name];
  if (value === undefined || value === true) {
    printError(`Missing required argument: --${name}`);
    // printError calls process.exit(1), but TypeScript doesn't know that
    throw new Error("unreachable");
  }
  return value;
}

/** Extract an optional string argument. */
export function optionalArg(
  args: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === true) {
    return undefined;
  }
  return value;
}

/** Split comma-separated values, trim whitespace. */
export function parseCsv(value: string): string[] {
  return value.split(",").map((s) => s.trim());
}
