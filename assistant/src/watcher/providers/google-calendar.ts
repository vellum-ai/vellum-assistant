/**
 * Google Calendar watcher provider — uses incremental sync for efficient change detection.
 *
 * On first poll, performs a full sync to capture the current syncToken as the watermark.
 * Subsequent polls use the syncToken with events.list to detect new/updated events.
 * Falls back to listing recent upcoming events if the syncToken has expired (410 Gone).
 */

import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Inlined types & helpers (previously imported from bundled-skills)
// ---------------------------------------------------------------------------

/** Event time - either a dateTime with timezone or a date for all-day events. */
interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** Calendar event attendee. */
interface EventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
}

/** Calendar event organizer. */
interface EventOrganizer {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** A single Google Calendar event. */
interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  attendees?: EventAttendee[];
  organizer?: EventOrganizer;
  htmlLink?: string;
  created?: string;
  updated?: string;
}

/** Events list response. */
interface CalendarEventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

/** List events from a calendar. */
async function listEvents(
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
  const query: Record<string, string> = {};

  if (options?.timeMin) query.timeMin = options.timeMin;
  if (options?.timeMax) query.timeMax = options.timeMax;
  query.maxResults = String(options?.maxResults ?? 25);
  if (options?.query) query.q = options.query;

  // Default to expanding recurring events into instances
  const singleEvents = options?.singleEvents ?? true;
  query.singleEvents = String(singleEvents);

  if (singleEvents && options?.orderBy) {
    query.orderBy = options.orderBy;
  } else if (singleEvents) {
    query.orderBy = "startTime";
  }

  if (options?.pageToken) query.pageToken = options.pageToken;
  if (options?.syncToken) query.syncToken = options.syncToken;

  const resp = await connection.request({
    method: "GET",
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    query,
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    headers: {
      "Content-Type": "application/json",
    },
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
    return undefined as unknown as CalendarEventsListResponse;
  }
  return resp.body as CalendarEventsListResponse;
}

const log = getLogger("watcher:google-calendar");

/** The credential service — calendar shares OAuth tokens with Gmail. */
const CREDENTIAL_SERVICE = "google";

function eventToItem(event: CalendarEvent, eventType: string): WatcherItem {
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const end = event.end?.dateTime ?? event.end?.date ?? "";

  // Include updated timestamp in the dedup key so subsequent edits to the
  // same event aren't silently dropped by the watcher_id + external_id constraint.
  const version = event.updated ?? "";
  return {
    externalId: version ? `${event.id}@${version}` : event.id,
    eventType,
    summary: `Calendar event: ${event.summary ?? "(no title)"} — ${start}`,
    payload: {
      id: event.id,
      summary: event.summary ?? "",
      start,
      end,
      location: event.location ?? "",
      description: event.description ?? "",
      status: event.status ?? "confirmed",
      organizer: event.organizer?.email ?? "",
      attendees:
        event.attendees?.map((a) => ({
          email: a.email,
          responseStatus: a.responseStatus,
        })) ?? [],
      htmlLink: event.htmlLink ?? "",
    },
    timestamp: event.updated ? new Date(event.updated).getTime() : Date.now(),
  };
}

interface SyncResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * Perform an incremental sync using the stored syncToken.
 * Follows pagination (nextPageToken) until the final page returns nextSyncToken.
 * Returns all accumulated events and the final nextSyncToken.
 */
async function incrementalSync(
  connection: OAuthConnection,
  syncToken: string,
): Promise<SyncResponse> {
  let allItems: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const query: Record<string, string> = { syncToken };
    if (pageToken) query.pageToken = pageToken;

    const resp = await connection.request({
      method: "GET",
      path: "/calendars/primary/events",
      query,
      baseUrl: GOOGLE_CALENDAR_BASE_URL,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      if (resp.status === 410) {
        throw new SyncTokenExpiredError(bodyStr);
      }
      throw new CalendarApiError(
        resp.status,
        "",
        `Calendar Sync API ${resp.status}: ${bodyStr}`,
      );
    }

    const page = resp.body as SyncResponse;
    if (page.items) allItems = allItems.concat(page.items);
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  return { items: allItems, nextSyncToken };
}

class SyncTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncTokenExpiredError";
  }
}

export const googleCalendarProvider: WatcherProvider = {
  id: "google-calendar",
  displayName: "Google Calendar",
  requiredCredentialService: CREDENTIAL_SERVICE,

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService);

    // Do a full sync with a narrow window to get the initial syncToken.
    // The API may paginate even for small result sets, so follow nextPageToken
    // until we reach the final page that carries the nextSyncToken.
    const now = new Date().toISOString();
    let pageToken: string | undefined;
    let syncToken: string | undefined;

    do {
      const result = await listEvents(connection, "primary", {
        timeMin: now,
        maxResults: 250,
        singleEvents: true,
        pageToken,
      });
      syncToken = result.nextSyncToken;
      pageToken = result.nextPageToken;
    } while (pageToken && !syncToken);

    if (!syncToken) {
      throw new Error("Calendar API did not return a syncToken");
    }
    return syncToken;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark — paginate through to get the initial syncToken, return no items
      const now = new Date().toISOString();
      let pageToken: string | undefined;
      let syncToken: string | undefined;

      do {
        const result = await listEvents(connection, "primary", {
          timeMin: now,
          maxResults: 250,
          singleEvents: true,
          pageToken,
        });
        syncToken = result.nextSyncToken;
        pageToken = result.nextPageToken;
      } while (pageToken && !syncToken);

      return { items: [], watermark: syncToken ?? "" };
    }

    try {
      const syncResp = await incrementalSync(connection, watermark);
      const newWatermark = syncResp.nextSyncToken ?? watermark;

      if (!syncResp.items || syncResp.items.length === 0) {
        return { items: [], watermark: newWatermark };
      }

      // Convert events to watcher items, distinguishing new vs updated
      const items: WatcherItem[] = [];
      for (const event of syncResp.items) {
        if (event.status === "cancelled") continue;

        const eventType =
          event.created === event.updated
            ? "new_calendar_event"
            : "updated_calendar_event";
        items.push(eventToItem(event, eventType));
      }

      log.info(
        { count: items.length, watermark: newWatermark },
        "Calendar: fetched event changes",
      );
      return { items, watermark: newWatermark };
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) {
        log.warn("Calendar syncToken expired, falling back to recent events");
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when syncToken expires: list upcoming events from today.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const now = new Date().toISOString();
  const result = await listEvents(connection, "primary", {
    timeMin: now,
    maxResults: 25,
    singleEvents: true,
    orderBy: "startTime",
  });

  const items = (result.items ?? []).map((event) =>
    eventToItem(event, "new_calendar_event"),
  );

  // Paginate through to get a fresh syncToken for the next watermark
  let pageToken: string | undefined;
  let syncToken: string | undefined;

  do {
    const syncResult = await listEvents(connection, "primary", {
      timeMin: now,
      maxResults: 250,
      singleEvents: true,
      pageToken,
    });
    syncToken = syncResult.nextSyncToken;
    pageToken = syncResult.nextPageToken;
  } while (pageToken && !syncToken);

  return { items, watermark: syncToken ?? "" };
}
