import type {
  CalendarEvent,
  CalendarEventsListResponse,
  CalendarListResponse,
  FreeBusyRequest,
  FreeBusyResponse,
} from "./types.js";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

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
  token: string,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${CALENDAR_API_BASE}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new CalendarApiError(
      resp.status,
      resp.statusText,
      `Calendar API ${resp.status}: ${body}`,
    );
  }
  const contentLength = resp.headers.get("content-length");
  if (resp.status === 204 || contentLength === "0") {
    return undefined as T;
  }
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** List events from a calendar. */
export async function listEvents(
  token: string,
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
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
}

/** Get a single event by ID. */
export async function getEvent(
  token: string,
  eventId: string,
  calendarId = "primary",
): Promise<CalendarEvent> {
  return request<CalendarEvent>(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(
      eventId,
    )}`,
  );
}

/** Create a new event. */
export async function createEvent(
  token: string,
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
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      method: "POST",
      body: JSON.stringify(event),
    },
  );
}

/** Update an event (patch). */
export async function patchEvent(
  token: string,
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
    token,
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
  token: string,
  query: FreeBusyRequest,
): Promise<FreeBusyResponse> {
  return request<FreeBusyResponse>(token, "/freeBusy", {
    method: "POST",
    body: JSON.stringify(query),
  });
}

/** List calendars the user has access to. */
export async function listCalendars(
  token: string,
): Promise<CalendarListResponse> {
  return request<CalendarListResponse>(token, "/users/me/calendarList");
}
