/**
 * Route handlers for contact management endpoints.
 *
 * GET   /v1/contacts              — list contacts
 * POST  /v1/contacts              — create or update a contact
 * GET   /v1/contacts/:id          — get a contact by ID
 * POST  /v1/contacts/merge        — merge two contacts
 * PATCH /v1/contacts/channels/:id — update a contact channel's status/policy
 */

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
import { httpError } from "../http-errors.js";

const VALID_CONTACT_TYPES: readonly ContactType[] = ["human", "assistant"];
const VALID_ASSISTANT_SPECIES: readonly AssistantSpecies[] = [
  "vellum",
  "openclaw",
];

/**
 * GET /v1/contacts?limit=50&role=guardian&contactType=human
 *
 * Also supports search query params: query, channelAddress, channelType, relationship.
 * When any search param is provided, delegates to searchContacts() instead of listContacts().
 */
export function handleListContacts(url: URL, assistantId: string): Response {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const role = url.searchParams.get("role") as ContactRole | null;
  const contactTypeParam = url.searchParams.get("contactType");
  const query = url.searchParams.get("query");
  const channelAddress = url.searchParams.get("channelAddress");
  const channelType = url.searchParams.get("channelType");
  const relationship = url.searchParams.get("relationship");

  if (contactTypeParam && !isContactType(contactTypeParam)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid contactType "${contactTypeParam}". Must be one of: ${VALID_CONTACT_TYPES.join(", ")}`,
      400,
    );
  }

  const hasSearchParams =
    query || channelAddress || channelType || relationship;

  const contactType = contactTypeParam
    ? (contactTypeParam as ContactType)
    : undefined;

  if (hasSearchParams) {
    const contacts = searchContacts({
      assistantId,
      query: query ?? undefined,
      channelAddress: channelAddress ?? undefined,
      channelType: channelType ?? undefined,
      relationship: relationship ?? undefined,
      role: role ?? undefined,
      contactType,
      limit,
    });
    return Response.json({ ok: true, contacts });
  }

  const contacts = listContacts(
    assistantId,
    limit,
    role ?? undefined,
    contactType,
  );
  return Response.json({ ok: true, contacts });
}

/**
 * GET /v1/contacts/:id
 */
export function handleGetContact(
  contactId: string,
  assistantId: string,
): Response {
  const contact = getContact(contactId, assistantId);
  if (!contact) {
    return httpError("NOT_FOUND", `Contact "${contactId}" not found`, 404);
  }
  const assistantMeta =
    contact.contactType === "assistant"
      ? getAssistantContactMetadata(contact.id)
      : undefined;
  return Response.json({
    ok: true,
    contact,
    assistantMetadata: assistantMeta ?? undefined,
  });
}

/**
 * POST /v1/contacts/merge { keepId, mergeId }
 */
export async function handleMergeContacts(
  req: Request,
  assistantId: string,
): Promise<Response> {
  const body = (await req.json()) as { keepId?: string; mergeId?: string };

  if (!body.keepId || !body.mergeId) {
    return httpError("BAD_REQUEST", "keepId and mergeId are required", 400);
  }

  try {
    const contact = mergeContacts(body.keepId, body.mergeId, assistantId);
    return Response.json({ ok: true, contact });
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
 * POST /v1/contacts { displayName, id?, relationship?, importance?, contactType?, assistantMetadata?, ... }
 */
export async function handleUpsertContact(
  req: Request,
  assistantId: string,
): Promise<Response> {
  const body = (await req.json()) as {
    id?: string;
    displayName?: string;
    relationship?: string;
    importance?: number;
    responseExpectation?: string;
    preferredTone?: string;
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

  if (
    body.importance !== undefined &&
    (typeof body.importance !== "number" ||
      Number.isNaN(body.importance) ||
      body.importance < 0 ||
      body.importance > 1)
  ) {
    return httpError(
      "BAD_REQUEST",
      "importance must be a number between 0 and 1",
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
      relationship: body.relationship,
      importance: body.importance,
      responseExpectation: body.responseExpectation,
      preferredTone: body.preferredTone,
      role: body.role as ContactRole | undefined,
      contactType: body.contactType as ContactType | undefined,
      assistantId,
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
      { ok: true, contact },
      { status: contact.created ? 201 : 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError("BAD_REQUEST", message, 400);
  }
}

/**
 * PATCH /v1/contacts/channels/:channelId { status?, policy?, reason? }
 */
export async function handleUpdateContactChannel(
  req: Request,
  channelId: string,
  assistantId: string,
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

  const parentContact = getContact(updated.contactId, assistantId);
  return Response.json({ ok: true, contact: parentContact ?? undefined });
}
