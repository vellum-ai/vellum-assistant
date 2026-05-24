export const SAVED_SECRET_PLACEHOLDER = "•".repeat(8);

export function secretPlaceholder(
  defaultPlaceholder: string,
  hasStoredSecret: boolean,
): string {
  return hasStoredSecret ? SAVED_SECRET_PLACEHOLDER : defaultPlaceholder;
}
