/** A decimal-string amount as a number, or null when there is none to read. */
export function parseUsd(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
