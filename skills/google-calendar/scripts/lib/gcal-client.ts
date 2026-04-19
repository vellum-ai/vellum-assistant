#!/usr/bin/env bun

/**
 * Authenticated Google Calendar API client.
 * Uses `assistant oauth request` under the hood for portable OAuth.
 */

export interface GcalRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  account?: string;
  headers?: Record<string, string>;
}

export interface GcalResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

/** Event time - either a dateTime with timezone or a date for all-day events. */
export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** Calendar event attendee. */
export interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

/** Calendar event organizer. */
export interface EventOrganizer {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** A single Google Calendar event. */
export interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
  organizer?: EventOrganizer;
  creator?: { email?: string; displayName?: string };
  htmlLink?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  hangoutLink?: string;
  conferenceData?: Record<string, unknown>;
}

/** Events list response. */
export interface CalendarEventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  summary?: string;
  timeZone?: string;
  updated?: string;
  nextSyncToken?: string;
}

/** Free/busy query request body. */
export interface FreeBusyRequest {
  timeMin: string;
  timeMax: string;
  timeZone?: string;
  items: Array<{ id: string }>;
}

/** A single busy period. */
export interface BusyPeriod {
  start: string;
  end: string;
}

/** Free/busy response for a single calendar. */
export interface CalendarFreeBusy {
  busy: BusyPeriod[];
  errors?: Array<{ domain: string; reason: string }>;
}

/** Free/busy query response. */
export interface FreeBusyResponse {
  kind?: string;
  timeMin?: string;
  timeMax?: string;
  calendars?: Record<string, CalendarFreeBusy>;
}

/** Calendar list entry (metadata about a calendar). */
export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
}

/** Calendar list response. */
export interface CalendarListResponse {
  items?: CalendarListEntry[];
  nextPageToken?: string;
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
 * Execute an authenticated Google Calendar API request via `assistant oauth request`.
 * Retries 429 and 5xx errors with exponential backoff for idempotent methods.
 */
export async function gcalRequest<T = unknown>(
  opts: GcalRequestOptions,
): Promise<GcalResponse<T>> {
  const method = (opts.method ?? "GET").toUpperCase();
  const canRetry = IDEMPOTENT_METHODS.has(method);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const args: string[] = [
      "assistant",
      "oauth",
      "request",
      "--provider",
      "google",
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

    let path = `https://www.googleapis.com/calendar/v3${opts.path}`;
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
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
export async function gcalGet<T = unknown>(
  path: string,
  query?: Record<string, string>,
  account?: string,
): Promise<GcalResponse<T>> {
  return gcalRequest<T>({ method: "GET", path, query, account });
}

/** Convenience wrapper for POST requests. */
export async function gcalPost<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GcalResponse<T>> {
  return gcalRequest<T>({ method: "POST", path, body, account });
}

/** Convenience wrapper for PATCH requests. */
export async function gcalPatch<T = unknown>(
  path: string,
  body: unknown,
  account?: string,
): Promise<GcalResponse<T>> {
  return gcalRequest<T>({ method: "PATCH", path, body, account });
}

/** Convenience wrapper for DELETE requests. */
export async function gcalDelete(
  path: string,
  account?: string,
): Promise<GcalResponse<void>> {
  return gcalRequest<void>({ method: "DELETE", path, account });
}

/** Options for listing calendar events. */
export interface ListEventsOptions {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  q?: string;
  singleEvents?: boolean;
  orderBy?: string;
  pageToken?: string;
  syncToken?: string;
  account?: string;
}

/**
 * List events from a calendar.
 * Wraps GET /calendars/{calendarId}/events.
 */
export async function listEvents(
  calendarId: string = "primary",
  options?: ListEventsOptions,
): Promise<GcalResponse<CalendarEventsListResponse>> {
  const query: Record<string, string> = {};

  if (options?.timeMin) query.timeMin = options.timeMin;
  if (options?.timeMax) query.timeMax = options.timeMax;
  if (options?.maxResults !== undefined)
    query.maxResults = String(options.maxResults);
  if (options?.q) query.q = options.q;
  if (options?.singleEvents !== undefined)
    query.singleEvents = String(options.singleEvents);
  if (options?.orderBy) query.orderBy = options.orderBy;
  if (options?.pageToken) query.pageToken = options.pageToken;
  if (options?.syncToken) query.syncToken = options.syncToken;

  return gcalGet<CalendarEventsListResponse>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    Object.keys(query).length > 0 ? query : undefined,
    options?.account,
  );
}

/**
 * Get a single event by ID.
 * Wraps GET /calendars/{calendarId}/events/{eventId}.
 */
export async function getEvent(
  eventId: string,
  calendarId: string = "primary",
  account?: string,
): Promise<GcalResponse<CalendarEvent>> {
  return gcalGet<CalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    undefined,
    account,
  );
}

/**
 * Create a new event on a calendar.
 * Wraps POST /calendars/{calendarId}/events.
 */
export async function createEvent(
  event: Partial<CalendarEvent>,
  calendarId: string = "primary",
  sendUpdates?: "all" | "externalOnly" | "none",
  account?: string,
): Promise<GcalResponse<CalendarEvent>> {
  const query: Record<string, string> = {};
  if (sendUpdates) query.sendUpdates = sendUpdates;

  return gcalRequest<CalendarEvent>({
    method: "POST",
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    query: Object.keys(query).length > 0 ? query : undefined,
    body: event,
    account,
  });
}

/**
 * Patch (partially update) an existing event.
 * Wraps PATCH /calendars/{calendarId}/events/{eventId}.
 */
export async function patchEvent(
  eventId: string,
  updates: Partial<CalendarEvent>,
  calendarId: string = "primary",
  sendUpdates?: "all" | "externalOnly" | "none",
  account?: string,
): Promise<GcalResponse<CalendarEvent>> {
  const query: Record<string, string> = {};
  if (sendUpdates) query.sendUpdates = sendUpdates;

  return gcalRequest<CalendarEvent>({
    method: "PATCH",
    path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    query: Object.keys(query).length > 0 ? query : undefined,
    body: updates,
    account,
  });
}

/**
 * Query free/busy information.
 * Wraps POST /freeBusy.
 */
export async function freeBusy(
  query: FreeBusyRequest,
  account?: string,
): Promise<GcalResponse<FreeBusyResponse>> {
  return gcalPost<FreeBusyResponse>("/freeBusy", query, account);
}

/**
 * List all calendars available to the user.
 * Wraps GET /users/me/calendarList.
 */
export async function listCalendars(
  account?: string,
): Promise<GcalResponse<CalendarListResponse>> {
  return gcalGet<CalendarListResponse>(
    "/users/me/calendarList",
    undefined,
    account,
  );
}
