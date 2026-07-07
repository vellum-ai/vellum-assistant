/**
 * Conservative duplicate-contact heuristic behind the merge suggestion
 * callout on the contact detail page.
 *
 * A candidate is suggested only on strong identity overlap — false positives
 * lead users toward a destructive merge, so misses are preferred:
 *
 *  1. Same normalized display name (case/whitespace-insensitive), excluding
 *     generic placeholder names.
 *  2. Same email root: the local part of an email identity (email channel
 *     address, or a display name that is itself an email address), lowercased
 *     with dots removed and any `+suffix` stripped.
 *  3. An email root that equals the other contact's full-name slug
 *     (e.g. `jane.doe@example.com` ↔ "Jane Doe"). First-name-only overlap is
 *     deliberately NOT a match.
 *
 * Guardian and assistant contacts are never suggested.
 */
import type { ContactPayload } from "@/domains/contacts/types";

const GENERIC_NAMES = new Set(["", "new contact", "unknown"]);

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Local part of an email, lowercased, dots removed, `+suffix` stripped. */
function emailRoot(address: string): string | null {
  const at = address.indexOf("@");
  if (at <= 0 || address.indexOf("@", at + 1) !== -1) {
    return null;
  }
  const local = address.slice(0, at).toLowerCase();
  const withoutSuffix = (local.split("+")[0] ?? local).replaceAll(".", "");
  return withoutSuffix.length > 0 ? withoutSuffix : null;
}

function emailRoots(contact: ContactPayload): Set<string> {
  const roots = new Set<string>();
  for (const channel of contact.channels) {
    if (channel.type !== "email" || channel.status === "revoked") {
      continue;
    }
    const root = emailRoot(channel.address);
    if (root) {
      roots.add(root);
    }
  }
  const nameRoot = emailRoot(contact.displayName.trim());
  if (nameRoot) {
    roots.add(nameRoot);
  }
  return roots;
}

/**
 * Full-name slug for email-root comparison: all name tokens concatenated
 * (letters/digits only). Requires at least two tokens so a bare first name
 * never matches an email root.
 */
function fullNameSlug(name: string): string | null {
  if (name.includes("@")) {
    return null;
  }
  const tokens = normalizeName(name)
    .split(" ")
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return null;
  }
  return tokens.join("");
}

function isMergeableCandidate(contact: ContactPayload): boolean {
  return contact.role !== "guardian" && contact.contactType !== "assistant";
}

export function isLikelyDuplicate(
  a: ContactPayload,
  b: ContactPayload,
): boolean {
  const nameA = normalizeName(a.displayName);
  const nameB = normalizeName(b.displayName);
  if (
    !GENERIC_NAMES.has(nameA) &&
    !GENERIC_NAMES.has(nameB) &&
    nameA === nameB
  ) {
    return true;
  }

  const rootsA = emailRoots(a);
  const rootsB = emailRoots(b);
  for (const root of rootsA) {
    if (rootsB.has(root)) {
      return true;
    }
  }

  const slugA = fullNameSlug(a.displayName);
  const slugB = fullNameSlug(b.displayName);
  if (slugA && rootsB.has(slugA)) {
    return true;
  }
  if (slugB && rootsA.has(slugB)) {
    return true;
  }

  return false;
}

/**
 * First likely duplicate of `contact` among `candidates` (never the contact
 * itself, never a guardian or assistant contact), or null.
 */
export function findDuplicateCandidate(
  contact: ContactPayload,
  candidates: ContactPayload[],
): ContactPayload | null {
  if (!isMergeableCandidate(contact)) {
    return null;
  }
  for (const candidate of candidates) {
    if (candidate.id === contact.id) {
      continue;
    }
    if (!isMergeableCandidate(candidate)) {
      continue;
    }
    if (isLikelyDuplicate(contact, candidate)) {
      return candidate;
    }
  }
  return null;
}
