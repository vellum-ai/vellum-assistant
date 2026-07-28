/**
 * User-facing name for the assistant on the contacts/channels surfaces,
 * falling back when the identity hasn't hydrated or is blank.
 */
export function assistantDisplayName(name: string | null | undefined): string {
  return name?.trim() || "your assistant";
}
