import type {
  OAuthConnection,
  OAuthConnectionResponse,
} from "../../../oauth/connection.js";
import type {
  OutlookCalendarEvent,
  OutlookCalendarEventListResponse,
  OutlookCalendarListResponse,
  OutlookDateTimeZone,
  OutlookScheduleResponse,
} from "./types.js";

export class OutlookCalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "OutlookCalendarApiError";
  }
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "PATCH",
]);

function isIdempotent(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Make an authenticated request to the Microsoft Graph API with retry logic.
 *
 * The OAuth provider's baseUrl is `https://graph.microsoft.com`, so all paths
 * must include the full API version and resource prefix (e.g. `/v1.0/me/events`).
 */
async function request<T>(
  connection: OAuthConnection,
  path: string,
  options?: RequestInit,
  query?: Record<string, string | string[]>,
): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  const canRetry = isIdempotent(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: OAuthConnectionResponse;
    try {
      const extraHeaders =
        options?.headers &&
        typeof options.headers === "object" &&
        !Array.isArray(options.headers)
          ? (options.headers as Record<string, string>)
          : {};
      resp = await connection.request({
        method,
        path,
        query,
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: options?.body ? JSON.parse(options.body as string) : undefined,
      });
    } catch (err) {
      // Network-level errors from connection.request() are not retryable
      throw err;
    }

    if (resp.status < 200 || resp.status >= 300) {
      if (canRetry && isRetryable(resp.status) && attempt < MAX_RETRIES) {
        const retryAfter =
          resp.headers["retry-after"] ?? resp.headers["Retry-After"];
        const delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      throw new OutlookCalendarApiError(
        resp.status,
        "",
        `Microsoft Graph API ${resp.status}: ${bodyStr}`,
      );
    }

    // Success
    if (resp.status === 204 || resp.body === undefined) {
      return undefined as T;
    }
    return resp.body as T;
  }

  throw new Error(
    "Unreachable: retry loop exited without returning or throwing",
  );
}

/** List calendar events, optionally within a specific calendar. */
export async function listEvents(
  connection: OAuthConnection,
  calendarId?: string,
  options?: {
    top?: number;
    skip?: number;
    filter?: string;
    orderby?: string;
    select?: string;
  },
): Promise<OutlookCalendarEventListResponse> {
  const path =
    calendarId && calendarId !== "primary"
      ? `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`
      : "/v1.0/me/events";

  const query: Record<string, string> = {};
  if (options?.top !== undefined) query["$top"] = String(options.top);
  if (options?.skip !== undefined) query["$skip"] = String(options.skip);
  if (options?.filter) query["$filter"] = options.filter;
  query["$orderby"] = options?.orderby ?? "start/dateTime";
  if (options?.select) query["$select"] = options.select;

  return request<OutlookCalendarEventListResponse>(
    connection,
    path,
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
  );
}

/** Get a single calendar event by ID. */
export async function getEvent(
  connection: OAuthConnection,
  eventId: string,
  select?: string,
): Promise<OutlookCalendarEvent> {
  const query: Record<string, string> = {};
  if (select) query["$select"] = select;

  return request<OutlookCalendarEvent>(
    connection,
    `/v1.0/me/events/${encodeURIComponent(eventId)}`,
    undefined,
    Object.keys(query).length > 0 ? query : undefined,
  );
}

/** Create a new calendar event. */
export async function createEvent(
  connection: OAuthConnection,
  event: Partial<OutlookCalendarEvent>,
  calendarId?: string,
): Promise<OutlookCalendarEvent> {
  const path =
    calendarId && calendarId !== "primary"
      ? `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`
      : "/v1.0/me/events";

  return request<OutlookCalendarEvent>(connection, path, {
    method: "POST",
    body: JSON.stringify(event),
  });
}

/** Update (patch) an existing calendar event. */
export async function patchEvent(
  connection: OAuthConnection,
  eventId: string,
  updates: Partial<OutlookCalendarEvent>,
): Promise<OutlookCalendarEvent> {
  return request<OutlookCalendarEvent>(
    connection,
    `/v1.0/me/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
}

/** RSVP to a calendar event (accept, decline, or tentatively accept). */
export async function rsvpEvent(
  connection: OAuthConnection,
  eventId: string,
  response: "accepted" | "declined" | "tentative",
  sendResponse?: boolean,
  comment?: string,
): Promise<void> {
  const endpointMap: Record<string, string> = {
    accepted: "accept",
    declined: "decline",
    tentative: "tentativelyAccept",
  };

  const action = endpointMap[response];
  const body: Record<string, unknown> = {};
  if (sendResponse !== undefined) body.sendResponse = sendResponse;
  if (comment !== undefined) body.comment = comment;

  await request<void>(
    connection,
    `/v1.0/me/events/${encodeURIComponent(eventId)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/** Get free/busy schedule for one or more users by email address. */
export async function getSchedule(
  connection: OAuthConnection,
  query: {
    schedules: string[];
    startTime: OutlookDateTimeZone;
    endTime: OutlookDateTimeZone;
    availabilityViewInterval?: number;
  },
): Promise<OutlookScheduleResponse> {
  return request<OutlookScheduleResponse>(
    connection,
    "/v1.0/me/calendar/getSchedule",
    {
      method: "POST",
      body: JSON.stringify(query),
    },
  );
}

/** List all calendars in the user's mailbox. */
export async function listCalendars(
  connection: OAuthConnection,
): Promise<OutlookCalendarListResponse> {
  return request<OutlookCalendarListResponse>(connection, "/v1.0/me/calendars");
}
