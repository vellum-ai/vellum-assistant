/**
 * Route handlers for contact management endpoints.
 *
 * GET  /v1/contacts          — list contacts
 * GET  /v1/contacts/:id      — get a contact by ID
 * POST /v1/contacts/merge    — merge two contacts
 */

import { listContacts, getContact, mergeContacts } from '../../contacts/contact-store.js';

/**
 * GET /v1/contacts?limit=50
 */
export function handleListContacts(url: URL): Response {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const contacts = listContacts(limit);
  return Response.json({ ok: true, contacts });
}

/**
 * GET /v1/contacts/:id
 */
export function handleGetContact(contactId: string): Response {
  const contact = getContact(contactId);
  if (!contact) {
    return Response.json(
      { ok: false, error: `Contact "${contactId}" not found` },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, contact });
}

/**
 * POST /v1/contacts/merge { keepId, mergeId }
 */
export async function handleMergeContacts(req: Request): Promise<Response> {
  const body = (await req.json()) as { keepId?: string; mergeId?: string };

  if (!body.keepId || !body.mergeId) {
    return Response.json(
      { ok: false, error: 'keepId and mergeId are required' },
      { status: 400 },
    );
  }

  try {
    const contact = mergeContacts(body.keepId, body.mergeId);
    return Response.json({ ok: true, contact });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
