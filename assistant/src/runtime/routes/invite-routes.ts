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

import { z } from "zod";

import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  redeemVoiceInviteCode,
  revokeIngressInvite,
  triggerInviteCall,
} from "../invite-service.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleListInvites({ queryParams = {} }: RouteHandlerArgs) {
  const result = listIngressInvites({
    sourceChannel: queryParams.sourceChannel,
    status: queryParams.status,
  });

  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  return { ok: true, invites: result.data };
}

export async function handleCreateInvite({ body = {} }: RouteHandlerArgs) {
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
    throw new BadRequestError(result.error);
  }
  return { ok: true, invite: result.data };
}

export function handleRevokeInvite({ pathParams = {} }: RouteHandlerArgs) {
  const result = revokeIngressInvite(pathParams.id);

  if (!result.ok) {
    throw new NotFoundError(result.error);
  }
  return { ok: true, invite: result.data };
}

export async function handleRedeemInvite({ body = {} }: RouteHandlerArgs) {
  // Voice-code redemption path: triggered when `code` is present
  if (body.code != null) {
    const callerExternalUserId = body.callerExternalUserId as
      | string
      | undefined;
    const code = body.code as string | undefined;

    if (!callerExternalUserId || !code) {
      throw new BadRequestError("callerExternalUserId and code are required");
    }

    const result = redeemVoiceInviteCode({
      assistantId: body.assistantId as string | undefined,
      callerExternalUserId,
      sourceChannel: "phone",
      code,
    });

    if (!result.ok) {
      throw new BadRequestError(result.reason);
    }

    return {
      ok: true,
      type: result.type,
      memberId: result.memberId,
      ...(result.type === "redeemed" ? { inviteId: result.inviteId } : {}),
    };
  }

  // Token-based redemption path (default)
  const result = redeemIngressInvite({
    token: body.token as string | undefined,
    externalUserId: body.externalUserId as string | undefined,
    externalChatId: body.externalChatId as string | undefined,
    sourceChannel: body.sourceChannel as string | undefined,
  });

  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  return { ok: true, invite: result.data };
}

export async function handleTriggerInviteCall({
  pathParams = {},
}: RouteHandlerArgs) {
  const result = await triggerInviteCall(pathParams.id);
  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  return { ok: true, callSid: result.data.callSid };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "invites_list",
    endpoint: "contacts/invites",
    method: "GET",
    handler: handleListInvites,
    summary: "List invites",
    description:
      "Return all invites, optionally filtered by sourceChannel or status.",
    tags: ["contacts"],
    queryParams: [
      {
        name: "sourceChannel",
        description: "Filter by source channel",
      },
      {
        name: "status",
        description: "Filter by invite status",
      },
    ],
    responseBody: z.object({
      ok: z.boolean(),
      invites: z.array(z.unknown()).describe("Invite objects"),
    }),
  },
  {
    operationId: "invites_create",
    endpoint: "contacts/invites",
    method: "POST",
    handler: handleCreateInvite,
    responseStatus: "201",
    summary: "Create an invite",
    description:
      'Create a new invite. Supports voice invites when sourceChannel is "phone".',
    tags: ["contacts"],
    requestBody: z.object({
      contactId: z.string().describe("Contact to invite"),
      sourceChannel: z
        .string()
        .describe("Source channel (e.g. phone)")
        .optional(),
      note: z.string().describe("Optional note").optional(),
      maxUses: z.number().describe("Max redemptions").optional(),
      expiresInMs: z.number().describe("Expiry duration in ms").optional(),
      contactName: z.string().describe("Contact display name").optional(),
      expectedExternalUserId: z
        .string()
        .describe("Expected user ID (E.164 for phone)")
        .optional(),
      friendName: z.string().describe("Friend name for the invite").optional(),
      guardianName: z.string().describe("Guardian name").optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      invite: z.object({}).passthrough().describe("Created invite"),
    }),
    additionalResponses: {
      "400": {
        description: "Invalid invite parameters",
      },
    },
  },
  {
    operationId: "invites_redeem",
    endpoint: "contacts/invites/redeem",
    method: "POST",
    handler: handleRedeemInvite,
    summary: "Redeem an invite",
    description: "Redeem an invite by token or voice code.",
    tags: ["contacts"],
    requestBody: z.object({
      token: z.string().describe("Invite token (token-based redemption)"),
      code: z.string().describe("Voice code (voice-code redemption)"),
      callerExternalUserId: z
        .string()
        .describe("Caller E.164 phone (voice-code)"),
      externalUserId: z.string().describe("External user ID (token-based)"),
      externalChatId: z.string().describe("External chat ID (token-based)"),
      sourceChannel: z.string().describe("Source channel (token-based)"),
      assistantId: z.string().describe("Assistant ID (voice-code)"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      invite: z
        .object({})
        .passthrough()
        .describe("Redeemed invite (token path)"),
      type: z.string().describe("Redemption type (voice path)"),
      memberId: z.string().describe("Member ID (voice path)"),
    }),
    additionalResponses: {
      "400": {
        description: "Invalid redemption parameters or failed redemption",
      },
    },
  },
  {
    operationId: "invites_revoke",
    endpoint: "contacts/invites/:id",
    method: "DELETE",
    policyKey: "contacts/invites",
    handler: handleRevokeInvite,
    summary: "Revoke an invite",
    description: "Revoke an invite by ID.",
    tags: ["contacts"],
    additionalResponses: {
      "404": {
        description: "Invite not found",
      },
    },
  },
  {
    operationId: "invites_trigger_call",
    endpoint: "contacts/invites/:id/call",
    method: "POST",
    policyKey: "contacts/invites",
    handler: handleTriggerInviteCall,
    summary: "Trigger invite call",
    description: "Trigger an outbound call for a phone invite.",
    tags: ["contacts"],
    responseBody: z.object({
      ok: z.boolean(),
      callSid: z.string().describe("Call SID from the provider"),
    }),
    additionalResponses: {
      "400": {
        description: "Invite not eligible for outbound call",
      },
    },
  },
];
