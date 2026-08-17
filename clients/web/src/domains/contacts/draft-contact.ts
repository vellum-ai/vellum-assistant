/**
 * Name a freshly created contact is stored under until the user names it.
 *
 * The sentinel is persisted, so it stays in English regardless of the UI
 * language: it is what the daemon holds and what every client compares
 * against. Screens showing it substitute `contacts:contact.draftName`, which
 * is why {@link isDraftContactName} exists rather than the comparison being
 * inlined at each site.
 */
export const DRAFT_CONTACT_NAME = "New Contact";

export function isDraftContactName(name: string | null | undefined): boolean {
  return name === DRAFT_CONTACT_NAME;
}
