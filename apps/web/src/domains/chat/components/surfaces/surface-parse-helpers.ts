/**
 * Shared narrowing helpers for parsing unstructured daemon surface payloads.
 *
 * Surfaces receive their data as `Record<string, unknown>` from the daemon.
 * These helpers provide type-safe narrowing from `unknown` to concrete types
 * without `as any` casts or unsafe assertions.
 */

/** Narrow `unknown` → `string | undefined`. */
export function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Narrow `unknown` → `number | undefined`. Rejects NaN, ±Infinity, booleans, and empty strings. */
export function num(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === "boolean") return undefined;
  if (typeof val === "string" && val.trim() === "") return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

/** Narrow `unknown` → `Record<string, unknown> | undefined`. */
export function rec(val: unknown): Record<string, unknown> | undefined {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

/** Narrow `unknown` → `string | number | undefined`. */
export function strOrNum(val: unknown): string | number | undefined {
  return typeof val === "string" || typeof val === "number" ? val : undefined;
}

/**
 * Filter an unknown value down to an array of records.
 * Returns `[]` if the input is not an array; skips non-object items.
 */
export function filterRecords(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}
