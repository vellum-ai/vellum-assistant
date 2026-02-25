/**
 * Google People API client for contact search and listing.
 * Separate from the Gmail client due to a different base URL.
 */

import type { PeopleConnectionsResponse, PeopleSearchResponse } from './people-types.js';
import { GmailApiError } from './client.js';

const PEOPLE_API_BASE = 'https://people.googleapis.com/v1';

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations';

async function request<T>(token: string, url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new GmailApiError(resp.status, resp.statusText, `People API ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

/** List the user's contacts with pagination. */
export async function listContacts(
  token: string,
  pageSize = 50,
  pageToken?: string,
): Promise<PeopleConnectionsResponse> {
  const params = new URLSearchParams({
    personFields: PERSON_FIELDS,
    pageSize: String(pageSize),
  });
  if (pageToken) params.set('pageToken', pageToken);
  return request<PeopleConnectionsResponse>(token, `${PEOPLE_API_BASE}/people/me/connections?${params}`);
}

/** Search contacts by name or email. */
export async function searchContacts(
  token: string,
  query: string,
): Promise<PeopleSearchResponse> {
  const params = new URLSearchParams({
    query,
    readMask: PERSON_FIELDS,
  });
  return request<PeopleSearchResponse>(token, `${PEOPLE_API_BASE}/people:searchContacts?${params}`);
}
