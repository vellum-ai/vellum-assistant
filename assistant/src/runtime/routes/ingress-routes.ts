/**
 * Route handlers for ingress invite management.
 *
 * Invites:
 *   GET    /v1/ingress/invites        — list invites
 *   POST   /v1/ingress/invites        — create an invite (supports voice)
 *   DELETE /v1/ingress/invites/:id    — revoke an invite
 *   POST   /v1/ingress/invites/redeem — redeem an invite (token or voice code)
 *
 * Member/contact operations have been migrated to the /v1/contacts and
 * /v1/contacts/channels endpoints.
 */

import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  redeemVoiceInviteCode,
  revokeIngressInvite,
} from "../ingress-service.js";

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/**
 * GET /v1/ingress/invites?sourceChannel=&status=
 */
export function handleListInvites(url: URL): Response {
  const result = listIngressInvites({
    sourceChannel: url.searchParams.get("sourceChannel") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, invites: result.data });
}

/**
 * POST /v1/ingress/invites
 *
 * For voice invites, pass `sourceChannel: "voice"` with required
 * `expectedExternalUserId` (E.164 phone). Voice codes are always 6 digits.
 * The response will include a one-time `voiceCode` field that must be
 * communicated to the invited user out-of-band.
 */
export async function handleCreateInvite(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  const result = createIngressInvite({
    sourceChannel: body.sourceChannel as string | undefined,
    note: body.note as string | undefined,
    maxUses: body.maxUses as number | undefined,
    expiresInMs: body.expiresInMs as number | undefined,
    expectedExternalUserId: body.expectedExternalUserId as string | undefined,
    voiceCodeDigits: body.voiceCodeDigits as number | undefined,
    friendName: body.friendName as string | undefined,
    guardianName: body.guardianName as string | undefined,
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
 *
 * Unified invite redemption endpoint. Supports two modes:
 *
 * 1. **Token-based** (existing): pass `token`, `sourceChannel`, `externalUserId`, etc.
 * 2. **Voice code** (new): pass `code` and `callerExternalUserId` (E.164 phone).
 *    Optionally pass `assistantId`.
 *
 * The presence of `code` in the body selects voice-code redemption.
 */
export async function handleRedeemInvite(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  // Voice-code redemption path: triggered when `code` is present
  if (body.code != null) {
    const callerExternalUserId = body.callerExternalUserId as
      | string
      | undefined;
    const code = body.code as string | undefined;

    if (!callerExternalUserId || !code) {
      return Response.json(
        { ok: false, error: "callerExternalUserId and code are required" },
        { status: 400 },
      );
    }

    const result = redeemVoiceInviteCode({
      assistantId: body.assistantId as string | undefined,
      callerExternalUserId,
      sourceChannel: "voice",
      code,
    });

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: 400 },
      );
    }

    return Response.json({
      ok: true,
      type: result.type,
      memberId: result.memberId,
      ...(result.type === "redeemed" ? { inviteId: result.inviteId } : {}),
    });
  }

  // Token-based redemption path (default)
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
