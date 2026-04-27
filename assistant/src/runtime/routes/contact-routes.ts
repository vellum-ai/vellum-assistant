/**
 * Route handlers for contact management endpoints.
 *
 * Shared ROUTES are served by both the HTTP server and the IPC server.
 * Routes requiring raw Request, AuthContext, or special response status
 * codes remain HTTP-only via contactHttpOnlyRouteDefinitions() and
 * contactCatchAllRouteDefinitions().
 */

import { z } from "zod";

import {
  deleteContact,
  findGuardianContact,
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
import { isServiceGatewayPrincipal } from "../auth/context.js";
import type { AuthContext } from "../auth/types.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import {
  BadRequestError,
  ForbiddenError,
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
// Handlers (transport-agnostic)
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

function handleDeleteContact(contactId: string) {
  const result = deleteContact(contactId);
  if (result === "not_found") {
    throw new NotFoundError(`Contact "${contactId}" not found`);
  }
  if (result === "is_guardian") {
    throw new ForbiddenError("Cannot delete a guardian contact");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
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
    operationId: "deleteContact",
    endpoint: "contacts/:id",
    method: "DELETE",
    policyKey: "contacts",
    summary: "Delete a contact",
    description: "Delete a contact by ID.",
    tags: ["contacts"],
    responseStatus: "204",
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleDeleteContact(pathParams!.id),
  },
];

// ---------------------------------------------------------------------------
// HTTP-only route definitions (require raw Request, AuthContext, or
// conditional response status codes)
// ---------------------------------------------------------------------------

export async function handleMergeContacts(req: Request): Promise<Response> {
  const body = (await req.json()) as { keepId?: string; mergeId?: string };

  if (!body.keepId || !body.mergeId) {
    return httpError("BAD_REQUEST", "keepId and mergeId are required", 400);
  }

  try {
    const contact = mergeContacts(body.keepId, body.mergeId);
    return Response.json({
      ok: true,
      contact: withGuardianNameOverride(contact),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("BAD_REQUEST", message, 400);
  }
}

export async function handleUpsertContact(req: Request): Promise<Response> {
  const body = (await req.json()) as {
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
    return httpError(
      "BAD_REQUEST",
      "displayName is required and must be a non-empty string",
      400,
    );
  }

  if (body.contactType !== undefined && !isContactType(body.contactType)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid contactType "${body.contactType}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
      400,
    );
  }

  if (body.contactType === "assistant") {
    if (!body.assistantMetadata) {
      return httpError(
        "BAD_REQUEST",
        'assistantMetadata is required when contactType is "assistant"',
        400,
      );
    }
    if (!isAssistantSpecies(body.assistantMetadata.species)) {
      return httpError(
        "BAD_REQUEST",
        `Invalid species "${body.assistantMetadata.species}". Must be one of: ${VALID_ASSISTANT_SPECIES.join(", ")}`,
        400,
      );
    }
    try {
      validateSpeciesMetadata(
        body.assistantMetadata.species as AssistantSpecies,
        body.assistantMetadata.metadata ?? null,
      );
    } catch (err) {
      return httpError(
        "BAD_REQUEST",
        err instanceof Error ? err.message : String(err),
        400,
      );
    }
  }

  if (body.contactType === "human" && body.assistantMetadata) {
    return httpError(
      "BAD_REQUEST",
      'assistantMetadata must not be provided when contactType is "human"',
      400,
    );
  }

  if (body.assistantMetadata && !body.contactType) {
    return httpError(
      "BAD_REQUEST",
      'contactType must be "assistant" when assistantMetadata is provided',
      400,
    );
  }

  if (body.channels) {
    if (!Array.isArray(body.channels)) {
      return httpError("BAD_REQUEST", "channels must be an array", 400);
    }
    for (const ch of body.channels) {
      if (ch.status !== undefined && !isChannelStatus(ch.status)) {
        return httpError(
          "BAD_REQUEST",
          `Invalid channel status "${ch.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
          400,
        );
      }
      if (ch.policy !== undefined && !isChannelPolicy(ch.policy)) {
        return httpError(
          "BAD_REQUEST",
          `Invalid channel policy "${ch.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
          400,
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

    return Response.json(
      { ok: true, contact: withGuardianNameOverride(contact) },
      { status: contact.created ? 201 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("BAD_REQUEST", message, 400);
  }
}

async function handleUpdateContactChannel(
  req: Request,
  channelId: string,
): Promise<Response> {
  const body = (await req.json()) as {
    status?: string;
    policy?: string;
    reason?: string;
  };

  if (body.status !== undefined && !isChannelStatus(body.status)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid status "${
        body.status
      }". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
      400,
    );
  }

  if (body.policy !== undefined && !isChannelPolicy(body.policy)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid policy "${
        body.policy
      }". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
      400,
    );
  }

  if (body.status === "revoked") {
    const existing = getChannelById(channelId);
    if (!existing) {
      return httpError("NOT_FOUND", `Channel "${channelId}" not found`, 404);
    }
    if (existing.status === "blocked") {
      return httpError(
        "CONFLICT",
        "Cannot revoke a blocked channel. Unblock it first or leave it blocked.",
        409,
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
    return httpError("NOT_FOUND", `Channel "${channelId}" not found`, 404);
  }

  const parentContact = getContact(updated.contactId);
  return Response.json({
    ok: true,
    contact: parentContact
      ? withGuardianNameOverride(parentContact)
      : undefined,
  });
}

export async function handleAddGuardianChannel(
  req: Request,
  authContext: AuthContext,
): Promise<Response> {
  if (!isServiceGatewayPrincipal(authContext)) {
    return httpError(
      "FORBIDDEN",
      "This endpoint is restricted to platform service calls",
      403,
    );
  }

  const body = (await req.json()) as {
    type: string;
    address: string;
    externalUserId?: string;
    externalChatId?: string;
    status?: string;
    policy?: string;
  };

  if (!body.type || !body.address) {
    return httpError("BAD_REQUEST", "type and address are required", 400);
  }

  if (!body.externalUserId) {
    return httpError(
      "BAD_REQUEST",
      "externalUserId is required for trust resolution",
      400,
    );
  }

  if (body.status !== undefined && !isChannelStatus(body.status)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid channel status "${body.status}". Must be one of: ${VALID_CHANNEL_STATUSES.join(", ")}`,
      400,
    );
  }

  if (body.policy !== undefined && !isChannelPolicy(body.policy)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid channel policy "${body.policy}". Must be one of: ${VALID_CHANNEL_POLICIES.join(", ")}`,
      400,
    );
  }

  const guardian = findGuardianContact();
  if (!guardian) {
    return httpError(
      "NOT_FOUND",
      "No guardian contact exists. The guardian must be verified on at least one channel first.",
      404,
    );
  }

  const updated = upsertContact({
    id: guardian.id,
    displayName: guardian.displayName,
    role: "guardian",
    channels: [
      {
        ...body,
        status: (body.status as ChannelStatus) ?? "active",
        policy: body.policy as ChannelPolicy | undefined,
        verifiedAt: Date.now(),
        verifiedVia: "guardian_channel_endpoint",
      },
    ],
  });

  return Response.json(
    { ok: true, contact: withGuardianNameOverride(updated) },
    { status: 200 },
  );
}

export function contactHttpOnlyRouteDefinitions(): HTTPRouteDefinition[] {
  return [
    {
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
      handler: async ({ req }) => handleUpsertContact(req),
    },
    {
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
      handler: async ({ req }) => handleMergeContacts(req),
    },
    {
      endpoint: "contacts/guardian/channel",
      method: "POST",
      policyKey: "contacts",
      summary: "Add a channel to the guardian contact",
      description: "Used by the guardian to auto-verify their own channel.",
      tags: ["contacts"],
      requestBody: z.object({
        type: z.string().describe("Channel type, e.g. 'email'"),
        address: z
          .string()
          .describe("Channel address, e.g. 'user@example.com'"),
        externalUserId: z
          .string()
          .describe("External user ID for trust resolution"),
        status: z
          .string()
          .optional()
          .describe("Channel status (default: active)"),
      }),
      responseBody: z.object({
        ok: z.boolean(),
        contact: z
          .object({})
          .passthrough()
          .describe("Updated guardian contact"),
      }),
      handler: async ({ req, authContext }) =>
        handleAddGuardianChannel(req, authContext),
    },
    {
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
      handler: async ({ req, params }) =>
        handleUpdateContactChannel(req, params.contactChannelId),
    },
  ];
}
