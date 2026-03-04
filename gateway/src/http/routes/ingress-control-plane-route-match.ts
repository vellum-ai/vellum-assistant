export type IngressControlPlaneRoute =
  | { kind: "listMembers" }
  | { kind: "upsertMember" }
  | { kind: "blockMember"; memberId: string }
  | { kind: "revokeMember"; memberId: string }
  | { kind: "listInvites" }
  | { kind: "createInvite" }
  | { kind: "redeemInvite" }
  | { kind: "revokeInvite"; inviteId: string };

export function matchIngressControlPlaneRoute(
  pathname: string,
  method: string,
): IngressControlPlaneRoute | null {
  if (pathname === "/v1/ingress/members") {
    if (method === "GET") return { kind: "listMembers" };
    if (method === "POST") return { kind: "upsertMember" };
    return null;
  }

  if (pathname === "/v1/ingress/invites") {
    if (method === "GET") return { kind: "listInvites" };
    if (method === "POST") return { kind: "createInvite" };
    return null;
  }

  const memberBlockMatch = pathname.match(
    /^\/v1\/ingress\/members\/([^/]+)\/block$/,
  );
  if (memberBlockMatch && method === "POST") {
    return { kind: "blockMember", memberId: memberBlockMatch[1] };
  }

  const memberMatch = pathname.match(/^\/v1\/ingress\/members\/([^/]+)$/);
  if (memberMatch && method === "DELETE") {
    return { kind: "revokeMember", memberId: memberMatch[1] };
  }

  if (pathname === "/v1/ingress/invites/redeem" && method === "POST") {
    return { kind: "redeemInvite" };
  }

  const inviteMatch = pathname.match(/^\/v1\/ingress\/invites\/([^/]+)$/);
  if (inviteMatch && method === "DELETE") {
    return { kind: "revokeInvite", inviteId: inviteMatch[1] };
  }

  return null;
}
