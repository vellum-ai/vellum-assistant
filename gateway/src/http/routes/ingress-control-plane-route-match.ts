export type IngressControlPlaneRoute =
  | { kind: "listInvites" }
  | { kind: "createInvite" }
  | { kind: "redeemInvite" }
  | { kind: "revokeInvite"; inviteId: string };

export function matchIngressControlPlaneRoute(
  pathname: string,
  method: string,
): IngressControlPlaneRoute | null {
  if (
    pathname === "/v1/ingress/invites" ||
    pathname === "/v1/contacts/invites"
  ) {
    if (method === "GET") return { kind: "listInvites" };
    if (method === "POST") return { kind: "createInvite" };
    return null;
  }

  if (
    (pathname === "/v1/ingress/invites/redeem" ||
      pathname === "/v1/contacts/invites/redeem") &&
    method === "POST"
  ) {
    return { kind: "redeemInvite" };
  }

  const inviteMatch = pathname.match(
    /^\/v1\/(?:ingress|contacts)\/invites\/([^/]+)$/,
  );
  if (inviteMatch && method === "DELETE") {
    return { kind: "revokeInvite", inviteId: inviteMatch[1] };
  }

  return null;
}
