#!/usr/bin/env bun

/**
 * Authenticated Microsoft Graph API client for Outlook Calendar.
 * Uses `assistant oauth request` under the hood for portable OAuth.
 */

// ---------------------------------------------------------------------------
// Graph API request infrastructure
// ---------------------------------------------------------------------------

export interface GraphRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  account?: string;
  headers?: Record<string, string>;
}

export interface GraphResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "PATCH",
]);

/**
 * Execute an authenticated Microsoft Graph API request via `assistant oauth request`.
 * Retries 429 and 5xx errors with exponential backoff for idempotent methods.
 */
export async function graphRequest<T = unknown>(
  opts: GraphRequestOptions,
): Promise<GraphResponse<T>> {
  const method = (opts.method ?? "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const args: string[] = [
      "assistant",
      "oauth",
      "request",
      "--provider",
      "outlook",
    ];

    args.push("-X", method);

    if (opts.body !== undefined) {
      args.push("-d", JSON.stringify(opts.body));
      args.push("-H", "Content-Type: application/json");
    }

    if (opts.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        args.push("-H", `${key}: ${value}`);
      }
    }

    if (opts.account) {
      args.push("--account", opts.account);
    }

    let path = opts.path;
    if (opts.query && Object.keys(opts.query).length > 0) {
      // Build query string manually to preserve OData $ prefixes.
      // URLSearchParams encodes $ as %24, which breaks Graph API OData params.
      const qs = Object.entries(opts.query)
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k).replace(/%24/gi, "$")}=${encodeURIComponent(v)}`,
        )
        .join("&");
      path += "?" + qs;
    }

    args.push(path);
    args.push("--json");

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      throw new Error(
        `Failed to spawn assistant oauth request: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    let result: {
      ok: boolean;
      status: number;
      headers: Record<string, string>;
      body: unknown;
    };
    try {
      result = JSON.parse(stdout);
    } catch (err) {
      if (exitCode !== 0) {
        throw new Error(
          `assistant oauth request failed (exit ${exitCode}): ${stderr || stdout}`,
        );
      }
      throw new Error(
        `Failed to parse assistant oauth request output: ${err instanceof Error ? err.message : String(err)}. stdout: ${stdout}`,
      );
    }

    // Retry on 429 (rate limit) and 5xx (server error) for idempotent methods
    const isRetryable =
      result.status === 429 || (result.status >= 500 && result.status < 600);
    if (canRetry && isRetryable && attempt < MAX_RETRIES) {
      const retryAfter = result.headers?.["retry-after"];
      const delayMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    return {
      ok: result.ok,
      status: result.status,
      data: result.body as T,
    };
  }

  // Should not be reached, but satisfy TypeScript
  throw new Error("Retry loop exhausted without returning");
}

/** Convenience wrapper for GET requests. */
export async function graphGet<T = unknown>(
  path: string,
  query?: Record<string, string>,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "GET", path, query, account });
}

/** Convenience wrapper for POST requests. */
export async function graphPost<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "POST", path, body, account });
}

/** Convenience wrapper for PATCH requests. */
export async function graphPatch<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GraphResponse<T>> {
  return graphRequest<T>({ method: "PATCH", path, body, account });
}

/** Convenience wrapper for DELETE requests. */
export async function graphDelete(
  path: string,
  account?: string,
): Promise<GraphResponse<void>> {
  return graphRequest<void>({ method: "DELETE", path, account });
}

// ---------------------------------------------------------------------------
// Outlook Calendar type interfaces
// ---------------------------------------------------------------------------

/** Microsoft Graph date+time pair. timeZone may be omitted when dateTime carries an offset. */
export interface OutlookDateTimeZone {
  dateTime: string;
  timeZone?: string;
}

/** Attendee on a calendar event. */
export interface OutlookCalendarAttendee {
  emailAddress: { address: string; name?: string };
  type: "required" | "optional" | "resource";
  status?: {
    response:
      | "none"
      | "organizer"
      | "tentativelyAccepted"
      | "accepted"
      | "declined"
      | "notResponded";
    time?: string;
  };
}

/** Physical or virtual location for a calendar event. */
export interface OutlookLocation {
  displayName?: string;
  locationType?: string;
  address?: Record<string, unknown>;
  coordinates?: Record<string, unknown>;
}

/** Rich-text body of a calendar item. */
export interface OutlookItemBody {
  contentType: "text" | "html";
  content: string;
}

/** A single calendar event from Microsoft Graph. */
export interface OutlookCalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: OutlookItemBody;
  start?: OutlookDateTimeZone;
  end?: OutlookDateTimeZone;
  location?: OutlookLocation;
  locations?: OutlookLocation[];
  attendees?: OutlookCalendarAttendee[];
  organizer?: { emailAddress: { address: string; name?: string } };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?:
    | "free"
    | "tentative"
    | "busy"
    | "oof"
    | "workingElsewhere"
    | "unknown";
  importance?: "low" | "normal" | "high";
  sensitivity?: "normal" | "personal" | "private" | "confidential";
  webLink?: string;
  onlineMeetingUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  seriesMasterId?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  categories?: string[];
  responseStatus?: { response: string; time?: string };
}

/** Paginated list of calendar events. */
export interface OutlookCalendarEventListResponse {
  value?: OutlookCalendarEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  "@odata.count"?: number;
}

/** A single schedule item (free/busy block). */
export interface OutlookScheduleItem {
  status:
    | "free"
    | "tentative"
    | "busy"
    | "oof"
    | "workingElsewhere"
    | "unknown";
  start: OutlookDateTimeZone;
  end: OutlookDateTimeZone;
  subject?: string;
  location?: string;
}

/** Schedule information for one user. */
export interface OutlookScheduleInformation {
  scheduleId: string;
  availabilityView: string;
  scheduleItems: OutlookScheduleItem[];
  error?: Record<string, unknown>;
}

/** Response from the getSchedule endpoint. */
export interface OutlookScheduleResponse {
  value?: OutlookScheduleInformation[];
}

/** A calendar in the user's mailbox. */
export interface OutlookCalendar {
  id: string;
  name?: string;
  color?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: { name: string; address: string };
}

/** Paginated list of calendars. */
export interface OutlookCalendarListResponse {
  value?: OutlookCalendar[];
  "@odata.nextLink"?: string;
}

// ---------------------------------------------------------------------------
// Calendar-specific convenience functions
// ---------------------------------------------------------------------------

/** List calendar events, optionally within a specific calendar. */
export async function listEvents(
  calendarId?: string,
  options?: {
    top?: number;
    skip?: number;
    filter?: string;
    orderby?: string;
    select?: string;
    account?: string;
  },
): Promise<GraphResponse<OutlookCalendarEventListResponse>> {
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

  return graphGet<OutlookCalendarEventListResponse>(
    path,
    Object.keys(query).length > 0 ? query : undefined,
    options?.account,
  );
}

/** Get a single calendar event by ID. */
export async function getEvent(
  eventId: string,
  select?: string,
  account?: string,
): Promise<GraphResponse<OutlookCalendarEvent>> {
  const query: Record<string, string> = {};
  if (select) query["$select"] = select;

  return graphGet<OutlookCalendarEvent>(
    `/v1.0/me/events/${encodeURIComponent(eventId)}`,
    Object.keys(query).length > 0 ? query : undefined,
    account,
  );
}

/** Create a new calendar event. */
export async function createEvent(
  event: Partial<OutlookCalendarEvent>,
  calendarId?: string,
  account?: string,
): Promise<GraphResponse<OutlookCalendarEvent>> {
  const path =
    calendarId && calendarId !== "primary"
      ? `/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`
      : "/v1.0/me/events";

  return graphPost<OutlookCalendarEvent>(path, event, account);
}

/** Update (patch) an existing calendar event. */
export async function patchEvent(
  eventId: string,
  updates: Partial<OutlookCalendarEvent>,
  account?: string,
): Promise<GraphResponse<OutlookCalendarEvent>> {
  return graphPatch<OutlookCalendarEvent>(
    `/v1.0/me/events/${encodeURIComponent(eventId)}`,
    updates,
    account,
  );
}

/** RSVP to a calendar event (accept, decline, or tentatively accept). */
export async function rsvpEvent(
  eventId: string,
  response: "accepted" | "declined" | "tentative",
  sendResponse?: boolean,
  comment?: string,
  account?: string,
): Promise<GraphResponse<void>> {
  const endpointMap: Record<string, string> = {
    accepted: "accept",
    declined: "decline",
    tentative: "tentativelyAccept",
  };

  const action = endpointMap[response];
  const body: Record<string, unknown> = {};
  if (sendResponse !== undefined) body.sendResponse = sendResponse;
  if (comment !== undefined) body.comment = comment;

  return graphPost<void>(
    `/v1.0/me/events/${encodeURIComponent(eventId)}/${action}`,
    body,
    account,
  );
}

/** Get free/busy schedule for one or more users by email address. */
export async function getSchedule(
  query: {
    schedules: string[];
    startTime: OutlookDateTimeZone;
    endTime: OutlookDateTimeZone;
    availabilityViewInterval?: number;
  },
  account?: string,
): Promise<GraphResponse<OutlookScheduleResponse>> {
  return graphPost<OutlookScheduleResponse>(
    "/v1.0/me/calendar/getSchedule",
    query,
    account,
  );
}

/** List all calendars in the user's mailbox. */
export async function listCalendars(
  account?: string,
): Promise<GraphResponse<OutlookCalendarListResponse>> {
  return graphGet<OutlookCalendarListResponse>(
    "/v1.0/me/calendars",
    undefined,
    account,
  );
}

/** Get the current user's email address (needed for availability auto-resolve). */
export async function getMyEmail(
  account?: string,
): Promise<string> {
  const resp = await graphGet<{ mail?: string; userPrincipalName?: string }>(
    "/v1.0/me",
    { $select: "mail,userPrincipalName" },
    account,
  );
  if (!resp.ok) {
    throw new Error(`Failed to get user profile (status ${resp.status})`);
  }
  const email = resp.data.mail ?? resp.data.userPrincipalName;
  if (!email) {
    throw new Error("No email address found on user profile");
  }
  return email;
}
