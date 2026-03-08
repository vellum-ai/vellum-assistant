/**
 * Google Calendar watcher provider — uses incremental sync for efficient change detection.
 *
 * On first poll, performs a full sync to capture the current syncToken as the watermark.
 * Subsequent polls use the syncToken with events.list to detect new/updated events.
 * Falls back to listing recent upcoming events if the syncToken has expired (410 Gone).
 */

import {
  CalendarApiError,
  listEvents,
} from "../../config/bundled-skills/google-calendar/calendar-client.js";
import type { CalendarEvent } from "../../config/bundled-skills/google-calendar/types.js";
import { withValidToken } from "../../security/token-manager.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

const log = getLogger("watcher:google-calendar");

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/** The credential service — calendar shares OAuth tokens with Gmail. */
const CREDENTIAL_SERVICE = "integration:gmail";

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
  token: string,
  syncToken: string,
): Promise<SyncResponse> {
  let allItems: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  do {
    const params = new URLSearchParams({ syncToken });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${CALENDAR_API_BASE}/calendars/primary/events?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 410) {
        throw new SyncTokenExpiredError(body);
      }
      // Throw CalendarApiError so withValidToken can detect 401s via the status property
      throw new CalendarApiError(
        resp.status,
        resp.statusText,
        `Calendar Sync API ${resp.status}: ${body}`,
      );
    }

    const page = (await resp.json()) as SyncResponse;
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
    return withValidToken(credentialService, async (token) => {
      // Do a full sync with a narrow window to get the initial syncToken.
      // The API may paginate even for small result sets, so follow nextPageToken
      // until we reach the final page that carries the nextSyncToken.
      const now = new Date().toISOString();
      let pageToken: string | undefined;
      let syncToken: string | undefined;

      do {
        const result = await listEvents(token, "primary", {
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
    });
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    return withValidToken(credentialService, async (token) => {
      if (!watermark) {
        // No watermark — paginate through to get the initial syncToken, return no items
        const now = new Date().toISOString();
        let pageToken: string | undefined;
        let syncToken: string | undefined;

        do {
          const result = await listEvents(token, "primary", {
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
        const syncResp = await incrementalSync(token, watermark);
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
          return fallbackFetch(token);
        }
        throw err;
      }
    });
  },
};

/**
 * Fallback when syncToken expires: list upcoming events from today.
 */
async function fallbackFetch(token: string): Promise<FetchResult> {
  const now = new Date().toISOString();
  const result = await listEvents(token, "primary", {
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
    const syncResult = await listEvents(token, "primary", {
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
