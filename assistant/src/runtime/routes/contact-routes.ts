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
  upsertAssistantContactMetadata,
  upsertContact,
  validateSpeciesMetadata,
} from "../../contacts/contact-store.js";
import type {
  AssistantSpecies,
  ChannelPolicy,
  ChannelStatus,
  ContactRole,
  ContactType,
} from "../../contacts/types.js";
import { resolveGuardianName } from "../../prompts/user-reference.js";
import {
  createIngressInvite,
  listIngressInvites,
  redeemIngressInvite,
  redeemVoiceInviteCode,
  revokeIngressInvite,
  triggerInviteCall,
} from "../invite-service.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

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

const VALID_CONTACT_TYPES: readonly ContactType[] = ["human", "assistant"];
const VALID_ASSISTANT_SPECIES: readonly AssistantSpecies[] = [
  "vellum",
  "openclaw",
];

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

function isAssistantSpecies(value: string): value is AssistantSpecies {
  return (VALID_ASSISTANT_SPECIES as readonly string[]).includes(value);
}

function isChannelStatus(value: string): value is ChannelStatus {
  return (VALID_CHANNEL_STATUSES as readonly string[]).includes(value);
}

function isChannelPolicy(value: string): value is ChannelPolicy {
  return (VALID_CHANNEL_POLICIES as readonly string[]).includes(value);
}

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
      contacts: contacts.map(withGuardianNameOverride),
    };
  }

  const contacts = listContacts(limit, role, contactType);
  return {
    ok: true,
    contacts: contacts.map(withGuardianNameOverride),
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
    contact: withGuardianNameOverride(contact),
    assistantMetadata: assistantMeta ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Invite handlers (transport-agnostic)
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
        .array(z.unknown())
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

  // ── contacts/search ──────────────────────────────────────────────────
  {
    operationId: "search_contacts",
    endpoint: "contacts/search",
    method: "POST",
    summary: "Search contacts",
    description: "Search contacts by query, channel address, or channel type.",
    tags: ["contacts"],
    requestBody: z.object({
      query: z.string().optional(),
      channelAddress: z.string().optional(),
      channelType: z.string().optional(),
      limit: z.number().optional(),
    }),
    responseBody: z.array(z.object({}).passthrough()),
    handler: ({ body = {} }: RouteHandlerArgs) => {
      const parsed = z
        .object({
          query: z.string().optional(),
          channelAddress: z.string().optional(),
          channelType: z.string().optional(),
          limit: z.number().optional(),
        })
        .parse(body);
      return searchContacts(parsed);
    },
  },

  // ── contacts/:id (MUST be last — path param shadows sub-paths) ────
  {
    operationId: "getContact",
    endpoint: "contacts/:id",
    method: "GET",
    policyKey: "contacts",
    summary: "Get a contact",
    description:
      "Return a single contact with its channels and assistant metadata.",
    tags: ["contacts"],
    responseBody: z.object({
      ok: z.boolean(),
      contact: z.object({}).passthrough().describe("Contact details"),
      assistantMetadata: z
        .object({})
        .passthrough()
        .describe("Assistant-side metadata"),
    }),
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleGetContact(pathParams!.id),
  },
  {
    operationId: "upsert_contact",
    endpoint: "contacts",
    method: "POST",
    summary: "Create or update a contact",
    description:
      "Create a new contact or update an existing one. Supports upsert by contactId or channel handle.",
    tags: ["contacts"],
    requestBody: z.object({
      contactId: z.string().describe("Existing contact ID (for update)"),
      displayName: z.string().describe("Display name"),
      channels: z
        .array(z.unknown())
        .describe("Channel objects with channelId, handle, displayName"),
      assistantMetadata: z
        .object({})
        .passthrough()
        .describe("Assistant-side metadata"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: z
        .object({})
        .passthrough()
        .describe("Created or updated contact"),
    }),
    handler: (args: RouteHandlerArgs) => handleUpsertContactRoute(args),
  },
  {
    operationId: "merge_contacts",
    endpoint: "contacts/merge",
    method: "POST",
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
      contact: z.object({}).passthrough().describe("Merged contact"),
    }),
    handler: (args: RouteHandlerArgs) => handleMergeContactsRoute(args),
  },
  {
    operationId: "updateContactChannel",
    endpoint: "contact-channels/:contactChannelId",
    method: "PATCH",
    policyKey: "contact-channels",
    summary: "Update a contact channel",
    description: "Update status, policy, or reason on a contact's channel.",
    tags: ["contacts"],
    requestBody: z.object({
      status: z.string().describe("Channel status"),
      policy: z.string().describe("Channel policy"),
      reason: z.string().describe("Reason for the change"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      contact: z
        .object({})
        .passthrough()
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
    return { ok: true, contact: withGuardianNameOverride(contact) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadRequestError(message);
  }
}

function handleUpsertContactRoute(args: RouteHandlerArgs) {
  const body = (args.body ?? {}) as {
    id?: string;
    displayName?: string;
    notes?: string;
    role?: string;
    contactType?: string;
    assistantMetadata?: {
      species: string;
      metadata?: Record<string, unknown>;
    };
    channels?: Array<{
      type: string;
      address: string;
      isPrimary?: boolean;
      status?: string;
      policy?: string;
      externalUserId?: string;
      externalChatId?: string;
    }>;
  };

  if (
    !body.displayName ||
    typeof body.displayName !== "string" ||
    body.displayName.trim().length === 0
  ) {
    throw new BadRequestError(
      "displayName is required and must be a non-empty string",
    );
  }

  if (body.contactType !== undefined && !isContactType(body.contactType)) {
    throw new BadRequestError(
      `Invalid contactType "${body.contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
    );
  }

  if (body.contactType === "assistant") {
    if (!body.assistantMetadata) {
      throw new BadRequestError(
        'assistantMetadata is required when contactType is "assistant"',
      );
    }
    if (!isAssistantSpecies(body.assistantMetadata.species)) {
      throw new BadRequestError(
        `Invalid species "${body.assistantMetadata.species}". Must be one of: ${VALID_ASSISTANT_SPECIES.join(", ")}`,
      );
    }
    try {
      validateSpeciesMetadata(
        body.assistantMetadata.species as AssistantSpecies,
        body.assistantMetadata.metadata ?? null,
      );
    } catch (err) {
      throw new BadRequestError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (body.contactType === "human" && body.assistantMetadata) {
    throw new BadRequestError(
      'assistantMetadata must not be provided when contactType is "human"',
    );
  }

  if (body.assistantMetadata && !body.contactType) {
    throw new BadRequestError(
      'contactType must be "assistant" when assistantMetadata is provided',
    );
  }

  if (body.channels) {
    if (!Array.isArray(body.channels)) {
      throw new BadRequestError("channels must be an array");
    }
    for (const ch of body.channels) {
      if (ch.status !== undefined && !isChannelStatus(ch.status)) {
        throw new BadRequestError(
          `Invalid channel status "${ch.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
        );
      }
      if (ch.policy !== undefined && !isChannelPolicy(ch.policy)) {
        throw new BadRequestError(
          `Invalid channel policy "${ch.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
        );
      }
    }
  }

  try {
    const contact = upsertContact({
      id: body.id,
      displayName: body.displayName.trim(),
      notes: body.notes,
      role: body.role as ContactRole | undefined,
      contactType: body.contactType as ContactType | undefined,
      channels: body.channels?.map((ch) => ({
        ...ch,
        status: ch.status as ChannelStatus | undefined,
        policy: ch.policy as ChannelPolicy | undefined,
      })),
    });

    if (body.assistantMetadata) {
      upsertAssistantContactMetadata({
        contactId: contact.id,
        species: body.assistantMetadata.species as AssistantSpecies,
        metadata: body.assistantMetadata.metadata ?? null,
      });
    }

    return { ok: true, contact: withGuardianNameOverride(contact) };
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
    contact: parentContact
      ? withGuardianNameOverride(parentContact)
      : undefined,
  };
}


