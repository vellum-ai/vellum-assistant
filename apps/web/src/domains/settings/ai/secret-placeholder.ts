export const SAVED_SECRET_PLACEHOLDER =
  "••••••••  (Enter a new key to replace)";

export function secretPlaceholder(
  defaultPlaceholder: string,
  hasStoredSecret: boolean,
): string {
  return hasStoredSecret ? SAVED_SECRET_PLACEHOLDER : defaultPlaceholder;
}
