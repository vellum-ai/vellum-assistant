/**
 * Google People API client for contact search and listing.
 * Separate from the Gmail client due to a different base URL.
 */

import type { OAuthConnection } from "../../../oauth/connection.js";

const GOOGLE_PEOPLE_BASE_URL = "https://people.googleapis.com/v1";
import { GmailApiError } from "./client.js";
import type {
  PeopleConnectionsResponse,
  PeopleSearchResponse,
} from "./people-types.js";

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

async function request<T>(
  connection: OAuthConnection,
  path: string,
  query?: Record<string, string | string[]>,
): Promise<T> {
  const resp = await connection.request({
    method: "GET",
    path,
    query,
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
  connection: OAuthConnection,
  pageSize = 50,
  pageToken?: string,
): Promise<PeopleConnectionsResponse> {
  const query: Record<string, string> = {
    personFields: PERSON_FIELDS,
    pageSize: String(pageSize),
  };
  if (pageToken) query.pageToken = pageToken;
  return request<PeopleConnectionsResponse>(
    connection,
    "/people/me/connections",
    query,
  );
}

/** Search contacts by name or email. */
export async function searchContacts(
  connection: OAuthConnection,
  query: string,
): Promise<PeopleSearchResponse> {
  return request<PeopleSearchResponse>(connection, "/people:searchContacts", {
    query,
    readMask: PERSON_FIELDS,
  });
}
