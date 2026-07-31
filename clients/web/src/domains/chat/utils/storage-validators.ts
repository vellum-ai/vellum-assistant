/** Shared validation helpers for chat domain storage files. */

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function parseStringArray(raw: string): string[] | null {
  const parsed: unknown = JSON.parse(raw);
  return isStringArray(parsed) ? parsed : null;
}
