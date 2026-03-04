/**
 * Route handlers for contact management endpoints.
 *
 * GET   /v1/contacts              — list contacts
 * GET   /v1/contacts/:id          — get a contact by ID
 * POST  /v1/contacts/merge        — merge two contacts
 * PATCH /v1/contacts/channels/:id — update a contact channel's status/policy
 */

import { getContact, listContacts, mergeContacts, updateChannelStatus } from '../../contacts/contact-store.js';
import type { ChannelPolicy, ChannelStatus, ContactRole } from '../../contacts/types.js';
import { httpError } from '../http-errors.js';

/**
 * GET /v1/contacts?limit=50&role=guardian
 */
export function handleListContacts(url: URL): Response {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const role = url.searchParams.get('role') as ContactRole | null;
  const contacts = listContacts(limit, role ?? undefined);
  return Response.json({ ok: true, contacts });
}

/**
 * GET /v1/contacts/:id
 */
export function handleGetContact(contactId: string): Response {
  const contact = getContact(contactId);
  if (!contact) {
    return httpError('NOT_FOUND', `Contact "${contactId}" not found`, 404);
  }
  return Response.json({ ok: true, contact });
}

/**
 * POST /v1/contacts/merge { keepId, mergeId }
 */
export async function handleMergeContacts(req: Request): Promise<Response> {
  const body = (await req.json()) as { keepId?: string; mergeId?: string };

  if (!body.keepId || !body.mergeId) {
    return httpError('BAD_REQUEST', 'keepId and mergeId are required', 400);
  }

  try {
    const contact = mergeContacts(body.keepId, body.mergeId);
    return Response.json({ ok: true, contact });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return httpError('BAD_REQUEST', message, 400);
  }
}

/**
 * PATCH /v1/contacts/channels/:channelId { status?, policy?, reason? }
 */
export async function handleUpdateContactChannel(req: Request, channelId: string): Promise<Response> {
  const body = (await req.json()) as {
    status?: string;
    policy?: string;
    reason?: string;
  };

  const updated = updateChannelStatus(channelId, {
    status: body.status as ChannelStatus | undefined,
    policy: body.policy as ChannelPolicy | undefined,
    revokedReason: body.status !== undefined ? (body.status === 'revoked' ? body.reason ?? null : null) : undefined,
    blockedReason: body.status !== undefined ? (body.status === 'blocked' ? body.reason ?? null : null) : undefined,
  });

  if (!updated) {
    return httpError('NOT_FOUND', `Channel "${channelId}" not found`, 404);
  }

  const parentContact = getContact(updated.contactId);
  return Response.json({ ok: true, contact: parentContact ?? undefined });
}
