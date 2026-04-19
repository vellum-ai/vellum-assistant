/**
 * Outlook Calendar watcher provider — uses Microsoft Graph delta queries
 * for efficient change detection.
 *
 * On first poll, performs a delta query to capture the initial @odata.deltaLink
 * as the watermark (start from "now"). Subsequent polls use the deltaLink to
 * detect new/updated events. Falls back to a fresh delta query if the delta
 * token has expired (410 Gone).
 */

import type { OAuthConnection } from "../../oauth/connection.js";
import { resolveOAuthConnection } from "../../oauth/connection-resolver.js";
import { getLogger } from "../../util/logger.js";
import type {
  FetchResult,
  WatcherItem,
  WatcherProvider,
} from "../provider-types.js";

// ---------------------------------------------------------------------------
// Inlined types & helpers (previously imported from bundled-skills)
// ---------------------------------------------------------------------------

/** Microsoft Graph date+time pair. timeZone may be omitted when dateTime carries an offset. */
interface OutlookDateTimeZone {
  dateTime: string;
  timeZone?: string;
}

/** A single calendar event from Microsoft Graph (subset used by watcher). */
interface OutlookCalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: OutlookDateTimeZone;
  end?: OutlookDateTimeZone;
  location?: { displayName?: string };
  attendees?: Array<{
    emailAddress: { address: string };
    status?: { response: string };
  }>;
  organizer?: { emailAddress: { address: string; name?: string } };
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

class OutlookCalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = "OutlookCalendarApiError";
  }
}

const CREDENTIAL_SERVICE = "outlook";
const log = getLogger("watcher:outlook-calendar");

const DELTA_SELECT_FIELDS = [
  "subject",
  "start",
  "end",
  "location",
  "bodyPreview",
  "isAllDay",
  "showAs",
  "organizer",
  "attendees",
  "webLink",
  "createdDateTime",
  "lastModifiedDateTime",
  "isCancelled",
  "type",
].join(",");

function eventToItem(
  event: OutlookCalendarEvent,
  eventType: string,
): WatcherItem {
  const start = event.start?.dateTime ?? "";
  const end = event.end?.dateTime ?? "";

  // Include lastModifiedDateTime in the dedup key so subsequent edits to the
  // same event aren't silently dropped by the watcher_id + external_id constraint.
  const version = event.lastModifiedDateTime ?? "";
  const externalId = version ? `${event.id}@${version}` : event.id;

  return {
    externalId,
    eventType,
    summary: `Calendar event: ${event.subject ?? "(no title)"} — ${start}`,
    payload: {
      id: event.id,
      subject: event.subject ?? "",
      start,
      end,
      startTimeZone: event.start?.timeZone ?? "",
      endTimeZone: event.end?.timeZone ?? "",
      location: event.location?.displayName ?? "",
      bodyPreview: event.bodyPreview ?? "",
      isAllDay: event.isAllDay ?? false,
      showAs: event.showAs ?? "busy",
      organizer: event.organizer?.emailAddress?.address ?? "",
      attendees:
        event.attendees?.map((a) => ({
          email: a.emailAddress.address,
          response: a.status?.response,
        })) ?? [],
      webLink: event.webLink ?? "",
    },
    timestamp: event.lastModifiedDateTime
      ? new Date(event.lastModifiedDateTime).getTime()
      : Date.now(),
  };
}

/** Thrown when Microsoft Graph returns 410 Gone (delta token expired). */
class DeltaSyncExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeltaSyncExpiredError";
  }
}

interface DeltaSyncResult {
  items: OutlookCalendarEvent[];
  deltaLink: string;
}

/**
 * Perform an incremental delta sync using a stored @odata.deltaLink.
 * Follows pagination (@odata.nextLink) until the final page returns
 * @odata.deltaLink. Returns all accumulated events and the new deltaLink.
 */
async function deltaSync(
  connection: OAuthConnection,
  deltaLink: string,
): Promise<DeltaSyncResult> {
  const allItems: OutlookCalendarEvent[] = [];
  let currentUrl = deltaLink;
  let newDeltaLink: string | undefined;

  do {
    const parsed = new URL(currentUrl);
    const path = parsed.pathname;
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const resp = await connection.request({
      method: "GET",
      path,
      query: Object.keys(query).length > 0 ? query : undefined,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      if (resp.status === 410) {
        throw new DeltaSyncExpiredError(bodyStr);
      }
      throw new OutlookCalendarApiError(
        resp.status,
        "",
        `Microsoft Graph Calendar Delta API ${resp.status}: ${bodyStr}`,
      );
    }

    const page = resp.body as {
      value?: OutlookCalendarEvent[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    if (page.value) {
      allItems.push(...page.value);
    }

    newDeltaLink = page["@odata.deltaLink"];
    currentUrl = page["@odata.nextLink"] ?? "";
  } while (currentUrl && !newDeltaLink);

  if (!newDeltaLink) {
    throw new Error(
      "Outlook Calendar delta query completed without returning a deltaLink",
    );
  }

  return { items: allItems, deltaLink: newDeltaLink };
}

/**
 * Perform the initial delta query to capture the current position.
 * Queries calendarView/delta from now to 30 days out with the selected fields,
 * paginating through all pages until reaching the final @odata.deltaLink.
 */
async function initialDeltaQuery(
  connection: OAuthConnection,
): Promise<DeltaSyncResult> {
  const now = new Date();
  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const allItems: OutlookCalendarEvent[] = [];
  let nextLink: string | undefined;
  let newDeltaLink: string | undefined;

  // First request — initial delta query with parameters
  const initialQuery: Record<string, string> = {
    startDateTime: now.toISOString(),
    endDateTime: thirtyDaysOut.toISOString(),
    $select: DELTA_SELECT_FIELDS,
  };

  const firstResp = await connection.request({
    method: "GET",
    path: "/v1.0/me/calendarView/delta",
    query: initialQuery,
  });

  if (firstResp.status < 200 || firstResp.status >= 300) {
    const bodyStr =
      typeof firstResp.body === "string"
        ? firstResp.body
        : JSON.stringify(firstResp.body ?? "");
    throw new OutlookCalendarApiError(
      firstResp.status,
      "",
      `Microsoft Graph Calendar Delta API ${firstResp.status}: ${bodyStr}`,
    );
  }

  const firstPage = firstResp.body as {
    value?: OutlookCalendarEvent[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };

  if (firstPage.value) {
    allItems.push(...firstPage.value);
  }

  newDeltaLink = firstPage["@odata.deltaLink"];
  nextLink = firstPage["@odata.nextLink"];

  // Follow pagination until we get a deltaLink
  while (nextLink && !newDeltaLink) {
    const parsed = new URL(nextLink);
    const path = parsed.pathname;
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const resp = await connection.request({
      method: "GET",
      path,
      query: Object.keys(query).length > 0 ? query : undefined,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const bodyStr =
        typeof resp.body === "string"
          ? resp.body
          : JSON.stringify(resp.body ?? "");
      throw new OutlookCalendarApiError(
        resp.status,
        "",
        `Microsoft Graph Calendar Delta API ${resp.status}: ${bodyStr}`,
      );
    }

    const page = resp.body as {
      value?: OutlookCalendarEvent[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    if (page.value) {
      allItems.push(...page.value);
    }

    newDeltaLink = page["@odata.deltaLink"];
    nextLink = page["@odata.nextLink"];
  }

  if (!newDeltaLink) {
    throw new Error(
      "Outlook Calendar initial delta query completed without returning a deltaLink",
    );
  }

  return { items: allItems, deltaLink: newDeltaLink };
}

export const outlookCalendarProvider: WatcherProvider = {
  id: "outlook-calendar",
  displayName: "Outlook Calendar",
  requiredCredentialService: CREDENTIAL_SERVICE,

  async getInitialWatermark(credentialService: string): Promise<string> {
    const connection = await resolveOAuthConnection(credentialService);
    const { deltaLink } = await initialDeltaQuery(connection);
    return deltaLink;
  },

  async fetchNew(
    credentialService: string,
    watermark: string | null,
    _config: Record<string, unknown>,
    _watcherKey: string,
  ): Promise<FetchResult> {
    const connection = await resolveOAuthConnection(credentialService);

    if (!watermark) {
      // No watermark — get initial position, return no items
      const { deltaLink } = await initialDeltaQuery(connection);
      return { items: [], watermark: deltaLink };
    }

    try {
      const { items: events, deltaLink: newDeltaLink } = await deltaSync(
        connection,
        watermark,
      );

      if (events.length === 0) {
        return { items: [], watermark: newDeltaLink };
      }

      // Filter out cancelled events and convert to watcher items
      const items: WatcherItem[] = [];
      for (const event of events) {
        if (event.isCancelled) continue;

        const eventType =
          event.createdDateTime === event.lastModifiedDateTime
            ? "new_calendar_event"
            : "updated_calendar_event";
        items.push(eventToItem(event, eventType));
      }

      log.info(
        { count: items.length, watermark: newDeltaLink },
        "Outlook Calendar: fetched event changes",
      );

      return { items, watermark: newDeltaLink };
    } catch (err) {
      if (err instanceof DeltaSyncExpiredError) {
        log.warn(
          "Outlook Calendar delta token expired, falling back to fresh query",
        );
        return fallbackFetch(connection);
      }
      throw err;
    }
  },
};

/**
 * Fallback when delta token expires (410 Gone): perform a fresh initial
 * delta query to get current events and a new deltaLink.
 */
async function fallbackFetch(
  connection: OAuthConnection,
): Promise<FetchResult> {
  const { items: events, deltaLink } = await initialDeltaQuery(connection);

  const items = events
    .filter((event) => !event.isCancelled)
    .map((event) => eventToItem(event, "new_calendar_event"));

  return { items, watermark: deltaLink };
}
