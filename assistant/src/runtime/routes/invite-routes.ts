/**
 * Route handlers for invite management.
 *
 * Invites:
 *   GET    /v1/contacts/invites           — list invites
 *   POST   /v1/contacts/invites           — create an invite (supports voice)
 *   DELETE /v1/contacts/invites/:id       — revoke an invite
 *   POST   /v1/contacts/invites/redeem    — redeem an invite (token or voice code)
 *   POST   /v1/contacts/invites/:id/call  — trigger an outbound call for a phone invite
 */

import type { RouteDefinition } from "../http-router.js";
import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  redeemVoiceInviteCode,
  revokeIngressInvite,
  triggerInviteCall,
} from "../invite-service.js";

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/**
 * GET /v1/contacts/invites?sourceChannel=&status=
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
 * POST /v1/contacts/invites
 *
 * For voice invites, pass `sourceChannel: "phone"` with required
 * `expectedExternalUserId` (E.164 phone). Voice codes are always 6 digits.
 * The response will include a one-time `voiceCode` field that must be
 * communicated to the invited user out-of-band.
 */
export async function handleCreateInvite(req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, unknown>;

  const result = await createIngressInvite({
    sourceChannel: body.sourceChannel as string | undefined,
    note: body.note as string | undefined,
    maxUses: body.maxUses as number | undefined,
    expiresInMs: body.expiresInMs as number | undefined,
    contactName: body.contactName as string | undefined,
    expectedExternalUserId: body.expectedExternalUserId as string | undefined,
    voiceCodeDigits: body.voiceCodeDigits as number | undefined,
    friendName: body.friendName as string | undefined,
    guardianName: body.guardianName as string | undefined,
    contactId: body.contactId as string,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, invite: result.data }, { status: 201 });
}

/**
 * DELETE /v1/contacts/invites/:id
 */
export function handleRevokeInvite(inviteId: string): Response {
  const result = revokeIngressInvite(inviteId);

  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 404 });
  }
  return Response.json({ ok: true, invite: result.data });
}

/**
 * POST /v1/contacts/invites/redeem
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
      sourceChannel: "phone",
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

/**
 * POST /v1/contacts/invites/:id/call
 *
 * Trigger an outbound call for a phone invite. The invite must be active and
 * have sourceChannel "phone" with the required voice metadata populated.
 */
export async function handleTriggerInviteCall(
  inviteId: string,
): Promise<Response> {
  const result = await triggerInviteCall(inviteId);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true, callSid: result.data.callSid });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function inviteRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "contacts/invites",
      method: "GET",
      handler: ({ url }) => handleListInvites(url),
    },
    {
      endpoint: "contacts/invites",
      method: "POST",
      handler: async ({ req }) => handleCreateInvite(req),
    },
    {
      endpoint: "contacts/invites/redeem",
      method: "POST",
      handler: async ({ req }) => handleRedeemInvite(req),
    },
    {
      endpoint: "contacts/invites/:id",
      method: "DELETE",
      policyKey: "contacts/invites",
      handler: ({ params }) => handleRevokeInvite(params.id),
    },
    {
      endpoint: "contacts/invites/:id/call",
      method: "POST",
      policyKey: "contacts/invites",
      handler: async ({ params }) => handleTriggerInviteCall(params.id),
    },
  ];
}
