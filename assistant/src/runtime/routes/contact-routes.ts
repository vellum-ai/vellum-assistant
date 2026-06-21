/**
 * Route handlers for contact and invite management endpoints.
 *
 * All routes are served by both the HTTP server and the IPC server
 * via the shared ROUTES array.
 *
 * IMPORTANT: contacts/:id routes are placed LAST in the ROUTES array so
 * they don't shadow more-specific sub-paths like contacts/invites.
 */

import { z } from "zod";

import {
  getAssistantContactMetadata,
  getChannelById,
  getContact,
  listContacts,
  mergeContacts,
  searchContacts,
  updateChannelStatus,
} from "../../contacts/contact-store.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
  ContactType,
} from "../../contacts/types.js";
import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

import { ipcCallPersistent } from "../../ipc/gateway-client.js";
import { resolveGuardianName } from "../../prompts/user-reference.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  redeemIngressInvite,
  redeemVoiceInviteCode,
} from "../invite-service.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  RouteError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/**
 * Re-throw a relayed gateway `IpcCallError` as a `RouteError` so the IPC/HTTP
 * adapters honor its statusCode/errorCode (4xx surfaces as 4xx, not a generic
 * 500). Non-IpcCallError throws propagate unchanged.
 */
function rethrowGatewayError(err: unknown): never {
  if (err instanceof IpcCallError) {
    throw new RouteError(
      err.message,
      err.errorCode ?? "INTERNAL_ERROR",
      err.statusCode ?? 500,
      err.errorDetails,
    );
  }
  throw err;
}

function withGuardianNameOverride<
  T extends { role: string; displayName: string },
>(contact: T): T {
  if (contact.role === "guardian") {
    return {
      ...contact,
      displayName: resolveGuardianName(contact.displayName),
    };
  }
  return contact;
}

/** Adds `externalUserId` (= `address`) to each channel for older macOS clients. */
function withChannelCompat<T extends { channels: { address: string }[] }>(
  contact: T,
): T {
  return {
    ...contact,
    channels: contact.channels.map((ch) => ({
      ...ch,
      externalUserId: ch.address,
    })),
  };
}

/** Compose both response transforms (guardian display name + channel compat). */
function prepareContactResponse<
  T extends {
    role: string;
    displayName: string;
    channels: { address: string }[];
  },
>(contact: T): T {
  return withChannelCompat(withGuardianNameOverride(contact));
}

const VALID_CONTACT_TYPES: readonly ContactType[] = ["human", "assistant"];

const VALID_CHANNEL_STATUSES: readonly ChannelStatus[] = [
  "active",
  "pending",
  "revoked",
  "blocked",
  "unverified",
];
const VALID_CHANNEL_POLICIES: readonly ChannelPolicy[] = [
  "allow",
  "deny",
  "escalate",
];

function isContactType(value: string): value is ContactType {
  return (VALID_CONTACT_TYPES as readonly string[]).includes(value);
}

function isChannelStatus(value: string): value is ChannelStatus {
  return (VALID_CHANNEL_STATUSES as readonly string[]).includes(value);
}

function isChannelPolicy(value: string): value is ChannelPolicy {
  return (VALID_CHANNEL_POLICIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Response schemas (drive OpenAPI spec → codegen → typed SDK)
// ---------------------------------------------------------------------------

const contactChannelSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  /** @deprecated Echoes `address` for backwards compatibility with older macOS clients. */
  externalUserId: z.string().nullable(),
  status: z.string(),
  policy: z.string(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
});

const contactSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  notes: z.string().nullable().optional(),
  contactType: z.string().nullable().optional(),
  lastInteraction: z.number().nullable().optional(),
  interactionCount: z.number(),
  channels: z.array(contactChannelSchema),
});

// ---------------------------------------------------------------------------
// Contact handlers (transport-agnostic)
// ---------------------------------------------------------------------------

function handleListContacts(queryParams: Record<string, string>) {
  const limit = Number(queryParams.limit ?? 50);
  const role = (queryParams.role as ContactRole) || undefined;
  const contactTypeParam = queryParams.contactType;
  const query = queryParams.query || undefined;
  const channelAddress = queryParams.channelAddress || undefined;
  const channelType = queryParams.channelType || undefined;

  if (contactTypeParam && !isContactType(contactTypeParam)) {
    throw new BadRequestError(
      `Invalid contactType "${contactTypeParam}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
    );
  }

  const contactType = contactTypeParam
    ? (contactTypeParam as ContactType)
    : undefined;

  if (query || channelAddress || channelType) {
    const contacts = searchContacts({
      query,
      channelAddress,
      channelType,
      role,
      contactType,
      limit,
    });
    return {
      ok: true,
      contacts: contacts.map(prepareContactResponse),
    };
  }

  const contacts = listContacts(limit, role, contactType);
  return {
    ok: true,
    contacts: contacts.map(prepareContactResponse),
  };
}

function handleGetContact(contactId: string) {
  const contact = getContact(contactId);
  if (!contact) {
    throw new NotFoundError(`Contact "${contactId}" not found`);
  }
  const assistantMeta =
    contact.contactType === "assistant"
      ? getAssistantContactMetadata(contact.id)
      : undefined;
  return {
    ok: true,
    contact: prepareContactResponse(contact),
    assistantMetadata: assistantMeta ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Invite handlers (transport-agnostic)
// ---------------------------------------------------------------------------

// The gateway owns the canonical invite write path. These CLI handlers relay
// to the gateway IPC methods via `ipcCallPersistent` and no longer touch the
// assistant DB directly. (Redemption stays daemon-local — see the redeem route.)

export async function handleListInvites({ queryParams = {} }: RouteHandlerArgs) {
  try {
    const result = (await ipcCallPersistent("invites_list", {
      ...(queryParams.sourceChannel
        ? { sourceChannel: queryParams.sourceChannel }
        : {}),
      ...(queryParams.status ? { status: queryParams.status } : {}),
    })) as { invites: Array<Record<string, unknown>> };
    return { ok: true, invites: result.invites };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

export async function handleCreateInvite({ body = {} }: RouteHandlerArgs) {
  try {
    const result = (await ipcCallPersistent("invites_create", {
      contactId: body.contactId as string,
      sourceChannel: body.sourceChannel as string | undefined,
      note: body.note as string | undefined,
      maxUses: body.maxUses as number | undefined,
      expiresInMs: body.expiresInMs as number | undefined,
      contactName: body.contactName as string | undefined,
      expectedExternalUserId: body.expectedExternalUserId as string | undefined,
      voiceCodeDigits: body.voiceCodeDigits as number | undefined,
      friendName: body.friendName as string | undefined,
      guardianName: body.guardianName as string | undefined,
    })) as { invite: Record<string, unknown>; rawToken?: string };
    return {
      ok: true,
      invite: result.invite,
      ...(result.rawToken ? { rawToken: result.rawToken } : {}),
    };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

export async function handleRevokeInvite({ pathParams = {} }: RouteHandlerArgs) {
  try {
    const result = (await ipcCallPersistent("invites_revoke", {
      id: pathParams.id,
    })) as { invite: Record<string, unknown> };
    return { ok: true, invite: result.invite };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

/**
 * Redeem a voice invite code.
 *
 * Backs the HTTP `invites_redeem` route (voice path) and the IPC-only
 * `invites_redeem_voice` method. Wraps the identity-bound
 * `redeemVoiceInviteCode` path.
 */
export async function handleRedeemVoiceInvite({
  body = {},
}: RouteHandlerArgs) {
  const callerExternalUserId = body.callerExternalUserId as string | undefined;
  const code = body.code as string | undefined;

  if (!callerExternalUserId || !code) {
    throw new BadRequestError("callerExternalUserId and code are required");
  }

  const result = await redeemVoiceInviteCode({
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

/**
 * Redeem a token invite.
 *
 * Backs the HTTP `invites_redeem` route (token path) and the IPC-only
 * `invites_redeem_token` method. Wraps the generic `redeemIngressInvite`
 * token path.
 */
export async function handleRedeemTokenInvite({
  body = {},
}: RouteHandlerArgs) {
  const result = await redeemIngressInvite({
    token: body.token as string | undefined,
    externalUserId: body.externalUserId as string | undefined,
    externalChatId: body.externalChatId as string | undefined,
    sourceChannel: body.sourceChannel as string | undefined,
  });

  if (!result.ok) {
    throw new BadRequestError(result.error);
  }
  // Surface the redemption `type` so the gateway can skip mirroring an
  // `already_member` redeem (which consumes no invite use).
  return { ok: true, invite: result.data.invite, type: result.data.type };
}

export async function handleRedeemInvite(args: RouteHandlerArgs) {
  const body = args.body ?? {};
  if (body.code != null) {
    return handleRedeemVoiceInvite(args);
  }
  return handleRedeemTokenInvite(args);
}

export async function handleTriggerInviteCall({
  pathParams = {},
}: RouteHandlerArgs) {
  try {
    const result = (await ipcCallPersistent("invites_trigger_call", {
      id: pathParams.id,
    })) as { callSid: string };
    return { ok: true, callSid: result.callSid };
  } catch (err) {
    rethrowGatewayError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
//
// Order matters: contacts/invites/* routes must precede the contacts/:id
// catch-all to avoid the parameterized pattern shadowing literal sub-paths.
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  // ── contacts (exact) ────────────────────────────────────────────────
  {
    operationId: "listContacts",
    endpoint: "contacts",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List contacts",
    description:
      "Return all contacts, optionally filtered by type or channel status.",
    tags: ["contacts"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max contacts to return (default 50)",
      },
      {
        name: "role",
        schema: { type: "string" },
        description: "Filter by role (e.g. guardian)",
      },
      {
        name: "contactType",
        schema: { type: "string" },
        description: "Filter by contact type (human or assistant)",
      },
      {
        name: "query",
        schema: { type: "string" },
        description: "Full-text search query",
      },
      {
        name: "channelAddress",
        schema: { type: "string" },
        description: "Filter by channel address",
      },
      {
        name: "channelType",
        schema: { type: "string" },
        description: "Filter by channel type",
      },
    ],
    responseBody: z.object({
      ok: z.boolean(),
      contacts: z
        .array(contactSchema)
        .describe("Contact objects with channels and metadata"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListContacts(queryParams ?? {}),
  },

  // ── contacts/invites (must precede contacts/:id) ────────────────────
  {
    operationId: "invites_list",
    endpoint: "contacts/invites",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
      rawToken: z
        .string()
        .optional()
        .describe("One-time raw invite token (returned at creation only)"),
    }),
    additionalResponses: {
      "400": {
        description: "Invalid invite parameters",
      },
    },
  },
  {
    // Stays daemon-local by design: redemption is an inbound-channel path (not
    // a CLI ACL surface), and the assistant redemption service already claims
    // the gateway row by id via record_invite_redemption — relaying would loop.
    operationId: "invites_redeem",
    endpoint: "contacts/invites/redeem",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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

  // ── contacts/search ──────────────────────────────────────────────────
  {
    operationId: "search_contacts",
    endpoint: "contacts/search",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search contacts",
    description: "Search contacts by query, channel address, or channel type.",
    tags: ["contacts"],
    requestBody: z.object({
      query: z.string().optional(),
      channelAddress: z.string().optional(),
      channelType: z.string().optional(),
      limit: z.number().optional(),
    }),
    responseBody: z.array(contactSchema),
    handler: ({ body = {} }: RouteHandlerArgs) => {
      const parsed = z
        .object({
          query: z.string().optional(),
          channelAddress: z.string().optional(),
          channelType: z.string().optional(),
          limit: z.number().optional(),
        })
        .parse(body);
      return searchContacts(parsed).map(prepareContactResponse);
    },
  },

  // ── contacts/:id (MUST be last — path param shadows sub-paths) ────
  {
    operationId: "getContact",
    endpoint: "contacts/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a contact",
    description:
      "Return a single contact with its channels and assistant metadata.",
    tags: ["contacts"],
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema,
      assistantMetadata: z
        .object({
          contactId: z.string(),
          species: z.string(),
          metadata: z.object({}).passthrough().nullable(),
        })
        .optional()
        .describe("Assistant-side metadata"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleGetContact(pathParams!.id),
  },
  {
    operationId: "merge_contacts",
    endpoint: "contacts/merge",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Merge two contacts",
    description: "Merge two contacts, keeping one and absorbing the other.",
    tags: ["contacts"],
    requestBody: z.object({
      keepId: z.string().describe("ID of the contact to keep"),
      mergeId: z
        .string()
        .describe("ID of the contact to merge into the kept one"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema.describe("Merged contact"),
    }),
    handler: (args: RouteHandlerArgs) => handleMergeContactsRoute(args),
  },
  {
    operationId: "updateContactChannel",
    endpoint: "contact-channels/:contactChannelId",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update a contact channel",
    description: "Update status, policy, or reason on a contact's channel.",
    tags: ["contacts"],
    requestBody: z.object({
      status: z.string().optional().describe("Channel status"),
      policy: z.string().optional().describe("Channel policy"),
      reason: z.string().optional().describe("Reason for the change"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: contactSchema
        .optional()
        .describe("Updated contact (if applicable)"),
    }),
    handler: (args: RouteHandlerArgs) => handleUpdateContactChannelRoute(args),
  },
];

// ---------------------------------------------------------------------------
// Transport-agnostic handlers (moved from HTTP-only)
// ---------------------------------------------------------------------------

function handleMergeContactsRoute(args: RouteHandlerArgs) {
  const { body } = args;
  const keepId = body?.keepId as string | undefined;
  const mergeId = body?.mergeId as string | undefined;

  if (!keepId || !mergeId) {
    throw new BadRequestError("keepId and mergeId are required");
  }

  try {
    const contact = mergeContacts(keepId, mergeId);
    return { ok: true, contact: prepareContactResponse(contact) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }
}

function handleUpdateContactChannelRoute(args: RouteHandlerArgs) {
  const channelId = args.pathParams!.contactChannelId;
  const body = (args.body ?? {}) as {
    status?: string;
    policy?: string;
    reason?: string;
  };

  if (body.status !== undefined && !isChannelStatus(body.status)) {
    throw new BadRequestError(
      `Invalid status "${body.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
    );
  }

  if (body.policy !== undefined && !isChannelPolicy(body.policy)) {
    throw new BadRequestError(
      `Invalid policy "${body.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
    );
  }

  if (body.status === "revoked") {
    const existing = getChannelById(channelId);
    if (!existing) {
      throw new NotFoundError(`Channel "${channelId}" not found`);
    }
    if (existing.status === "blocked") {
      throw new ConflictError(
        "Cannot revoke a blocked channel. Unblock it first or leave it blocked.",
      );
    }
  }

  const updated = updateChannelStatus(channelId, {
    status: body.status,
    policy: body.policy,
    revokedReason:
      body.status !== undefined
        ? body.status === "revoked"
          ? (body.reason ?? null)
          : null
        : undefined,
    blockedReason:
      body.status !== undefined
        ? body.status === "blocked"
          ? (body.reason ?? null)
          : null
        : undefined,
  });

  if (!updated) {
    throw new NotFoundError(`Channel "${channelId}" not found`);
  }

  const parentContact = getContact(updated.contactId);
  return {
    ok: true,
    contact: parentContact ? prepareContactResponse(parentContact) : undefined,
  };
}
