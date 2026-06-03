/**
 * Parse a comma-separated list of model identifiers into trimmed, non-empty
 * ids. Shared by the onboarding API-key screen and the settings provider
 * editor so the "split → trim → drop empties" parse can't drift between them.
 */
export function parseModelIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}
