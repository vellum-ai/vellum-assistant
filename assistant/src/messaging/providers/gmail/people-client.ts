/**
 * Google People API client for contact search and listing.
 * Separate from the Gmail client due to a different base URL.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";
import { GOOGLE_PEOPLE_BASE_URL } from "../../../oauth/provider-base-urls.js";
import { GmailApiError } from "./client.js";
import type {
  PeopleConnectionsResponse,
  PeopleSearchResponse,
} from "./people-types.js";

/** Used by the legacy string-token path. */
const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

async function request<T>(
  connectionOrToken: OAuthConnection | string,
  path: string,
): Promise<T> {
  if (typeof connectionOrToken === "string") {
    // Legacy path: use raw token with full URL
    const token = connectionOrToken;
    const url = `${PEOPLE_API_BASE}${path}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new GmailApiError(
        resp.status,
        resp.statusText,
        `People API ${resp.status}: ${body}`,
      );
    }
    return resp.json() as Promise<T>;
  }

  // OAuthConnection path: use connection.request() with baseUrl override
  const connection = connectionOrToken;
  const resp = await connection.request({
    method: "GET",
    path,
    baseUrl: GOOGLE_PEOPLE_BASE_URL,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const bodyStr =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new GmailApiError(
      resp.status,
      "",
      `People API ${resp.status}: ${bodyStr}`,
    );
  }

  return resp.body as T;
}

/** List the user's contacts with pagination. */
export async function listContacts(
  connectionOrToken: OAuthConnection | string,
  pageSize = 50,
  pageToken?: string,
): Promise<PeopleConnectionsResponse> {
  const params = new URLSearchParams({
    personFields: PERSON_FIELDS,
    pageSize: String(pageSize),
  });
  if (pageToken) params.set("pageToken", pageToken);
  return request<PeopleConnectionsResponse>(
    connectionOrToken,
    `/people/me/connections?${params}`,
  );
}

/** Search contacts by name or email. */
export async function searchContacts(
  connectionOrToken: OAuthConnection | string,
  query: string,
): Promise<PeopleSearchResponse> {
  const params = new URLSearchParams({
    query,
    readMask: PERSON_FIELDS,
  });
  return request<PeopleSearchResponse>(
    connectionOrToken,
    `/people:searchContacts?${params}`,
  );
}
