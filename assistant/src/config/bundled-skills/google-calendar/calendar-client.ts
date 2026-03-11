import type { OAuthConnection } from "../../../oauth/connection.js";
import { GOOGLE_CALENDAR_BASE_URL } from "../../../oauth/provider-base-urls.js";
import type {
  CalendarEvent,
  CalendarEventsListResponse,
  CalendarListResponse,
  FreeBusyRequest,
  FreeBusyResponse,
} from "./types.js";

export class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

async function request<T>(
  connection: OAuthConnection,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();

  // Extract non-auth headers
  let extraHeaders: Record<string, string> | undefined;
  if (options?.headers) {
    const raw = options.headers;
    const result: Record<string, string> = {};
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        if (k.toLowerCase() !== "authorization") result[k] = v;
      });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) {
        if (k.toLowerCase() !== "authorization") result[k] = v;
      }
    } else {
      for (const [k, v] of Object.entries(raw)) {
        if (k.toLowerCase() !== "authorization" && v !== undefined)
          result[k] = v;
      }
    }
    if (Object.keys(result).length > 0) extraHeaders = result;
  }

  // Extract body
  let reqBody: unknown | undefined;
  if (options?.body) {
    if (typeof options.body === "string") {
      try {
        reqBody = JSON.parse(options.body);
      } catch {
        reqBody = options.body;
      }
    } else {
      reqBody = options.body;
    }
  }

  const resp = await connection.request({
    method,
    path,
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: reqBody,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const bodyStr =
      typeof resp.body === "string"
        ? resp.body
        : JSON.stringify(resp.body ?? "");
    throw new CalendarApiError(
      resp.status,
      "",
      `Calendar API ${resp.status}: ${bodyStr}`,
    );
  }

  if (resp.status === 204 || resp.body === undefined) {
    return undefined as T;
  }
  return resp.body as T;
}

/** List events from a calendar. */
export async function listEvents(
  connection: OAuthConnection,
  calendarId = "primary",
  options?: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
    query?: string;
    singleEvents?: boolean;
    orderBy?: "startTime" | "updated";
    pageToken?: string;
    syncToken?: string;
  },
): Promise<CalendarEventsListResponse> {
  const params = new URLSearchParams();

  if (options?.timeMin) params.set("timeMin", options.timeMin);
  if (options?.timeMax) params.set("timeMax", options.timeMax);
  params.set("maxResults", String(options?.maxResults ?? 25));
  if (options?.query) params.set("q", options.query);

  // Default to expanding recurring events into instances
  const singleEvents = options?.singleEvents ?? true;
  params.set("singleEvents", String(singleEvents));

  if (singleEvents && options?.orderBy) {
    params.set("orderBy", options.orderBy);
  } else if (singleEvents) {
    params.set("orderBy", "startTime");
  }

  if (options?.pageToken) params.set("pageToken", options.pageToken);
  if (options?.syncToken) params.set("syncToken", options.syncToken);

  return request<CalendarEventsListResponse>(
    connection,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
}

/** Get a single event by ID. */
export async function getEvent(
  connection: OAuthConnection,
  eventId: string,
  calendarId = "primary",
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    connection,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      eventId,
    )}`,
  );
}

/** Create a new event. */
export async function createEvent(
  connection: OAuthConnection,
  event: {
    summary: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
    description?: string;
    location?: string;
    attendees?: Array<{ email: string }>;
  },
  calendarId = "primary",
  sendUpdates: "all" | "externalOnly" | "none" = "all",
): Promise<CalendarEvent> {
  const params = new URLSearchParams({ sendUpdates });
  return request<CalendarEvent>(
    connection,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      method: "POST",
      body: JSON.stringify(event),
    },
  );
}

/** Update an event (patch). */
export async function patchEvent(
  connection: OAuthConnection,
  eventId: string,
  updates: Partial<{
    summary: string;
    description: string;
    location: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
    attendees: Array<{ email: string; responseStatus?: string }>;
  }>,
  calendarId = "primary",
  sendUpdates: "all" | "externalOnly" | "none" = "all",
): Promise<CalendarEvent> {
  const params = new URLSearchParams({ sendUpdates });
  return request<CalendarEvent>(
    connection,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      eventId,
    )}?${params}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
}

/** Query free/busy information. */
export async function freeBusy(
  connection: OAuthConnection,
  query: FreeBusyRequest,
): Promise<FreeBusyResponse> {
  return request<FreeBusyResponse>(connection, "/freeBusy", {
    method: "POST",
    body: JSON.stringify(query),
  });
}

/** List calendars the user has access to. */
export async function listCalendars(
  connection: OAuthConnection,
): Promise<CalendarListResponse> {
  return request<CalendarListResponse>(connection, "/users/me/calendarList");
}
