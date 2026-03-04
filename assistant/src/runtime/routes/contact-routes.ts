/**
 * Route handlers for contact management endpoints.
 *
 * GET   /v1/contacts              — list contacts
 * GET   /v1/contacts/:id          — get a contact by ID
 * POST  /v1/contacts/merge        — merge two contacts
 * PATCH /v1/contacts/channels/:id — update a contact channel's status/policy
 */

import {
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
} from "../../contacts/types.js";
import { httpError } from "../http-errors.js";

/**
 * GET /v1/contacts?limit=50&role=guardian
 *
 * Also supports search query params: query, channelAddress, channelType, relationship.
 * When any search param is provided, delegates to searchContacts() instead of listContacts().
 */
export function handleListContacts(url: URL, assistantId: string): Response {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const role = url.searchParams.get("role") as ContactRole | null;
  const query = url.searchParams.get("query");
  const channelAddress = url.searchParams.get("channelAddress");
  const channelType = url.searchParams.get("channelType");
  const relationship = url.searchParams.get("relationship");

  const hasSearchParams = query || channelAddress || relationship;

  if (hasSearchParams) {
    const contacts = searchContacts({
      assistantId,
      query: query ?? undefined,
      channelAddress: channelAddress ?? undefined,
      channelType: channelType ?? undefined,
      relationship: relationship ?? undefined,
      limit,
    });
    return Response.json({ ok: true, contacts });
  }

  const contacts = listContacts(assistantId, limit, role ?? undefined);
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
  return Response.json({ ok: true, contact });
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

function isChannelStatus(value: string): value is ChannelStatus {
  return (VALID_CHANNEL_STATUSES as readonly string[]).includes(value);
}

function isChannelPolicy(value: string): value is ChannelPolicy {
  return (VALID_CHANNEL_POLICIES as readonly string[]).includes(value);
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
