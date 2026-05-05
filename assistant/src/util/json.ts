/**
 * Parse JSON without throwing — returns null on failure.
 */
export function parseJsonSafe<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Convert any object's Date-valued fields to ISO strings. */
export function datesToISO<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: T[K] extends Date ? string : T[K] } {
  const result = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (value instanceof Date) {
      result[key] = value.toISOString();
    }
  }
  return result as { [K in keyof T]: T[K] extends Date ? string : T[K] };
}

/** Tolerant JSON parse that returns `{}` for invalid or non-object payloads. */
export function safeParseRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
