/**
 * Route handlers for contact management endpoints.
 *
 * GET    /v1/contacts              — list contacts
 * POST   /v1/contacts              — create or update a contact
 * GET    /v1/contacts/:id          — get a contact by ID
 * DELETE /v1/contacts/:id          — delete a contact
 * POST   /v1/contacts/merge        — merge two contacts
 * PATCH  /v1/contact-channels/:contactChannelId — update a contact channel's status/policy
 */

import {
  deleteContact,
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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

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

/**
 * GET /v1/contacts?limit=50&role=guardian&contactType=human
 *
 * Also supports search query params: query, channelAddress, channelType.
 * When any search param is provided, delegates to searchContacts() instead of listContacts().
 */
export function handleListContacts(url: URL): Response {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const role = url.searchParams.get("role") as ContactRole | null;
  const contactTypeParam = url.searchParams.get("contactType");
  const query = url.searchParams.get("query");
  const channelAddress = url.searchParams.get("channelAddress");
  const channelType = url.searchParams.get("channelType");
  if (contactTypeParam && !isContactType(contactTypeParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid contactType "${contactTypeParam}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
      400,
    );
  }

  const hasSearchParams = query || channelAddress || channelType;

  const contactType = contactTypeParam
    ? (contactTypeParam as ContactType)
    : undefined;

  if (hasSearchParams) {
    const contacts = searchContacts({
      query: query ?? undefined,
      channelAddress: channelAddress ?? undefined,
      channelType: channelType ?? undefined,
      role: role ?? undefined,
      contactType,
      limit,
    });
    return Response.json({
      ok: true,
      contacts: contacts.map(withGuardianNameOverride),
    });
  }

  const contacts = listContacts(limit, role ?? undefined, contactType);
  return Response.json({
    ok: true,
    contacts: contacts.map(withGuardianNameOverride),
  });
}

/**
 * GET /v1/contacts/:id
 */
export function handleGetContact(contactId: string): Response {
  const contact = getContact(contactId);
  if (!contact) {
    return httpError("NOT_FOUND", `Contact "${contactId}" not found`, 404);
  }
  const assistantMeta =
    contact.contactType === "assistant"
      ? getAssistantContactMetadata(contact.id)
      : undefined;
  return Response.json({
    ok: true,
    contact: withGuardianNameOverride(contact),
    assistantMetadata: assistantMeta ?? undefined,
  });
}

/**
 * DELETE /v1/contacts/:id
 */
export function handleDeleteContact(contactId: string): Response {
  const result = deleteContact(contactId);
  if (result === "not_found") {
    return httpError("NOT_FOUND", `Contact "${contactId}" not found`, 404);
  }
  if (result === "is_guardian") {
    return httpError("FORBIDDEN", "Cannot delete a guardian contact", 403);
  }
  return new Response(null, { status: 204 });
}

/**
 * POST /v1/contacts/merge { keepId, mergeId }
 */
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

/**
 * POST /v1/contacts { displayName, id?, notes?, contactType?, assistantMetadata?, ... }
 */
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

/**
 * PATCH /v1/contact-channels/:contactChannelId { status?, policy?, reason? }
 */
export async function handleUpdateContactChannel(
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

  // Blocked-state guard: revoking a blocked channel is not allowed because
  // blocking is a stronger action than revoking. The caller must explicitly
  // unblock (set status to "active") before revoking.
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function contactRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "contacts",
      method: "GET",
      handler: ({ url }) => handleListContacts(url),
    },
    {
      endpoint: "contacts",
      method: "POST",
      handler: async ({ req }) => handleUpsertContact(req),
    },
    {
      endpoint: "contacts/merge",
      method: "POST",
      handler: async ({ req }) => handleMergeContacts(req),
    },
    {
      endpoint: "contact-channels/:contactChannelId",
      method: "PATCH",
      policyKey: "contact-channels",
      handler: async ({ req, params }) =>
        handleUpdateContactChannel(req, params.contactChannelId),
    },
  ];
}

/**
 * Catch-all `contacts/:id` route. Must be registered AFTER any routes that
 * share the `contacts/` prefix (e.g. `inviteRouteDefinitions()`) to avoid
 * the `:id` parameter matching literal sub-paths like "invites".
 */
export function contactCatchAllRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "contacts/:id",
      method: "GET",
      policyKey: "contacts",
      handler: ({ params }) => handleGetContact(params.id),
    },
    {
      endpoint: "contacts/:id",
      method: "DELETE",
      policyKey: "contacts",
      handler: ({ params }) => handleDeleteContact(params.id),
    },
  ];
}
