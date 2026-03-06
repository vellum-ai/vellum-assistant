export type ContactsControlPlaneRoute =
  | { kind: "listContacts" }
  | { kind: "upsertContact" }
  | { kind: "getContact"; contactId: string }
  | { kind: "deleteContact"; contactId: string }
  | { kind: "mergeContacts" }
  | { kind: "updateContactChannel"; contactChannelId: string }
  | { kind: "listInvites" }
  | { kind: "createInvite" }
  | { kind: "redeemInvite" }
  | { kind: "revokeInvite"; inviteId: string }
  | { kind: "verifyContactChannel"; contactChannelId: string };

export function matchContactsControlPlaneRoute(
  pathname: string,
  method: string,
): ContactsControlPlaneRoute | null {
  // ── Contact CRUD ──
  if (pathname === "/v1/contacts") {
    if (method === "GET") return { kind: "listContacts" };
    if (method === "POST") return { kind: "upsertContact" };
    return null;
  }

  if (pathname === "/v1/contacts/merge" && method === "POST") {
    return { kind: "mergeContacts" };
  }

  // Channel status/policy updates
  const channelMatch = pathname.match(/^\/v1\/contact-channels\/([^/]+)$/);
  if (channelMatch && method === "PATCH") {
    return {
      kind: "updateContactChannel",
      contactChannelId: channelMatch[1],
    };
  }

  // Trusted channel verification
  const verifyMatch = pathname.match(
    /^\/v1\/contact-channels\/([^/]+)\/verify$/,
  );
  if (verifyMatch && method === "POST") {
    return {
      kind: "verifyContactChannel",
      contactChannelId: verifyMatch[1],
    };
  }

  // ── Invite routes ──
  if (pathname === "/v1/contacts/invites") {
    if (method === "GET") return { kind: "listInvites" };
    if (method === "POST") return { kind: "createInvite" };
    return null;
  }

  if (pathname === "/v1/contacts/invites/redeem" && method === "POST") {
    return { kind: "redeemInvite" };
  }

  const inviteMatch = pathname.match(/^\/v1\/contacts\/invites\/([^/]+)$/);
  if (inviteMatch && method === "DELETE") {
    return { kind: "revokeInvite", inviteId: inviteMatch[1] };
  }

  // Contact by ID — must come after /invites and /merge to avoid false matches
  const contactIdMatch = pathname.match(/^\/v1\/contacts\/([^/]+)$/);
  if (contactIdMatch) {
    if (method === "GET")
      return { kind: "getContact", contactId: contactIdMatch[1] };
    if (method === "DELETE")
      return { kind: "deleteContact", contactId: contactIdMatch[1] };
  }

  return null;
}
