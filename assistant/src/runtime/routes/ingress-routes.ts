/**
 * Route handlers for ingress member and invite management.
 *
 * Members:
 *   GET    /v1/ingress/members           — list members
 *   POST   /v1/ingress/members           — upsert a member
 *   DELETE /v1/ingress/members/:id       — revoke a member
 *   POST   /v1/ingress/members/:id/block — block a member
 *
 * Invites:
 *   GET    /v1/ingress/invites           — list invites
 *   POST   /v1/ingress/invites           — create an invite
 *   DELETE /v1/ingress/invites/:id       — revoke an invite
 *   POST   /v1/ingress/invites/redeem    — redeem an invite
 */

import {
  blockIngressMember,
  createIngressInvite,
  listIngressInvites,
  listIngressMembers,
  redeemIngressInvite,
  revokeIngressInvite,
  revokeIngressMember,
  upsertIngressMember,
} from '../ingress-service.js';

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * GET /v1/ingress/members?assistantId=&sourceChannel=&status=&policy=
 */
export function handleListMembers(url: URL): Response {
  const result = listIngressMembers({
    assistantId: url.searchParams.get('assistantId') ?? undefined,
    sourceChannel: url.searchParams.get('sourceChannel') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    policy: url.searchParams.get('policy') ?? undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, members: result.data });
}

/**
 * POST /v1/ingress/members
 */
export async function handleUpsertMember(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  const result = upsertIngressMember({
    sourceChannel: body.sourceChannel as string | undefined,
    externalUserId: body.externalUserId as string | undefined,
    externalChatId: body.externalChatId as string | undefined,
    displayName: body.displayName as string | undefined,
    username: body.username as string | undefined,
    policy: body.policy as string | undefined,
    status: body.status as string | undefined,
    assistantId: body.assistantId as string | undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, member: result.data });
}

/**
 * DELETE /v1/ingress/members/:id
 */
export async function handleRevokeMember(req: Request, memberId: string): Promise<Response> {
  let reason: string | undefined;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    reason = body.reason as string | undefined;
  } catch {
    // DELETE may have no body
  }

  const result = revokeIngressMember(memberId, reason);

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 404 });
  }
  return Response.json({ ok: true, member: result.data });
}

/**
 * POST /v1/ingress/members/:id/block
 */
export async function handleBlockMember(req: Request, memberId: string): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;
  const reason = body.reason as string | undefined;

  const result = blockIngressMember(memberId, reason);

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 404 });
  }
  return Response.json({ ok: true, member: result.data });
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/**
 * GET /v1/ingress/invites?sourceChannel=&status=
 */
export function handleListInvites(url: URL): Response {
  const result = listIngressInvites({
    sourceChannel: url.searchParams.get('sourceChannel') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, invites: result.data });
}

/**
 * POST /v1/ingress/invites
 */
export async function handleCreateInvite(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  const result = createIngressInvite({
    sourceChannel: body.sourceChannel as string | undefined,
    note: body.note as string | undefined,
    maxUses: body.maxUses as number | undefined,
    expiresInMs: body.expiresInMs as number | undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, invite: result.data }, { status: 201 });
}

/**
 * DELETE /v1/ingress/invites/:id
 */
export function handleRevokeInvite(inviteId: string): Response {
  const result = revokeIngressInvite(inviteId);

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 404 });
  }
  return Response.json({ ok: true, invite: result.data });
}

/**
 * POST /v1/ingress/invites/redeem
 */
export async function handleRedeemInvite(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  const result = redeemIngressInvite({
    token: body.token as string | undefined,
    externalUserId: body.externalUserId as string | undefined,
    externalChatId: body.externalChatId as string | undefined,
    sourceChannel: body.sourceChannel as string | undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, invite: result.data });
}
