/**
 * Schedules the onboarding "Day 2 Check-in" calendar event server-side.
 *
 * Flow:
 *   1. Resolve the Google OAuth connection, requiring the calendar.events scope.
 *      No connection / missing scope → a `scheduled: false` result (never an
 *      error): the web caller treats this as a best-effort skip.
 *   2. List tomorrow's timed events in the 8am–8pm window (user's timezone) to
 *      derive busy intervals. Uses events.list rather than freeBusy.query
 *      because the onboarding grant is the narrow `calendar.events` scope, which
 *      authorizes events.list/insert but not freeBusy.query.
 *   3. Choose the first open 15-minute slot (12pm–5pm, widening to 8am–8pm).
 *   4. Create the event with the locked title + HTML description, sendUpdates=all.
 *
 * Authenticates via `resolveOAuthConnection("google")` + `connection.request()`,
 * the same path the calendar watcher uses — no skill subprocess.
 */

import { canonicalizeTimeZone } from "../daemon/date-context.js";
import type { OAuthConnection } from "../oauth/connection.js";
import { resolveOAuthConnection } from "../oauth/connection-resolver.js";
import { getLogger } from "../util/logger.js";
import {
  buildCheckinDescription,
  buildCheckinTitle,
  checkinAvailabilityWindow,
  type CheckinNames,
  chooseCheckinSlot,
  extractBusyFromEvents,
  type GcalEvent,
} from "./checkin-event.js";

const log = getLogger("onboarding:schedule-checkin");

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
/** Calendar shares the Google OAuth connection with Gmail. */
const GOOGLE_PROVIDER = "google";
const PRIMARY_CALENDAR_ID = "primary";

export interface ScheduleCheckinInput extends CheckinNames {
  /** IANA timezone reported by the client (e.g. "America/New_York"). */
  timeZone?: string;
  /** Override "now" for deterministic tests. Defaults to the current time. */
  nowMs?: number;
}

export type ScheduleCheckinResult =
  | {
      scheduled: true;
      eventId: string;
      htmlLink: string | null;
      /** Event start, ISO 8601 (UTC). */
      start: string;
      /** Event end, ISO 8601 (UTC). */
      end: string;
      timeZone: string;
    }
  | {
      scheduled: false;
      /**
       * Why nothing was booked. `calendar_unavailable` covers both "not
       * connected" and "calendar scope not granted" — the client surfaces a
       * single best-effort skip either way.
       */
      reason: "calendar_unavailable";
    };

interface EventsListResponse {
  items?: GcalEvent[];
}

/** Subset of the events.insert response we surface back to the caller. */
interface CreatedEvent {
  id?: string;
  htmlLink?: string;
}

/**
 * Schedule the Day 2 check-in. Resolves to a `scheduled: false` result when no
 * calendar is connected; throws only on unexpected Calendar API failures (the
 * route handler maps those to a 5xx, the web caller swallows them).
 */
export async function scheduleOnboardingCheckin(
  input: ScheduleCheckinInput,
): Promise<ScheduleCheckinResult> {
  const timeZone =
    canonicalizeTimeZone(input.timeZone) ??
    // Fall back to the daemon host timezone when the client didn't report one.
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC";
  const nowMs = input.nowMs ?? Date.now();

  let connection: OAuthConnection;
  try {
    connection = await resolveOAuthConnection(GOOGLE_PROVIDER, {
      requiredScopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
    });
  } catch (err) {
    // No active connection or the calendar scope wasn't granted — skip quietly.
    log.info(
      { err: err instanceof Error ? err.message : String(err) },
      "Check-in skipped: Google Calendar not available",
    );
    return { scheduled: false, reason: "calendar_unavailable" };
  }

  const { timeMinMs, timeMaxMs } = checkinAvailabilityWindow(nowMs, timeZone);

  const eventsResp = await connection.request({
    method: "GET",
    path: `/calendars/${encodeURIComponent(PRIMARY_CALENDAR_ID)}/events`,
    query: {
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      // Expand recurring events into instances so each occurrence is a concrete
      // busy interval in the window.
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    },
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    headers: { "Content-Type": "application/json" },
  });
  if (eventsResp.status < 200 || eventsResp.status >= 300) {
    throw new Error(
      `Calendar events.list ${eventsResp.status}: ${stringifyBody(eventsResp.body)}`,
    );
  }

  const busy = extractBusyFromEvents(
    (eventsResp.body as EventsListResponse).items ?? [],
  );
  const slot = chooseCheckinSlot(nowMs, timeZone, busy);

  const uuid = crypto.randomUUID();
  const eventResp = await connection.request({
    method: "POST",
    path: `/calendars/${encodeURIComponent(PRIMARY_CALENDAR_ID)}/events`,
    query: { sendUpdates: "all" },
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    headers: { "Content-Type": "application/json" },
    body: {
      summary: buildCheckinTitle(input),
      description: buildCheckinDescription(uuid),
      start: {
        dateTime: new Date(slot.startMs).toISOString(),
        timeZone,
      },
      end: {
        dateTime: new Date(slot.endMs).toISOString(),
        timeZone,
      },
    },
  });
  if (eventResp.status < 200 || eventResp.status >= 300) {
    throw new Error(
      `Calendar event create ${eventResp.status}: ${stringifyBody(eventResp.body)}`,
    );
  }

  const event = eventResp.body as CreatedEvent;
  if (!event.id) {
    throw new Error("Calendar event create returned no event id");
  }

  log.info(
    {
      eventId: event.id,
      start: new Date(slot.startMs).toISOString(),
      window: slot.window,
      timeZone,
    },
    "Scheduled onboarding Day 2 check-in",
  );

  return {
    scheduled: true,
    eventId: event.id,
    htmlLink: event.htmlLink ?? null,
    start: new Date(slot.startMs).toISOString(),
    end: new Date(slot.endMs).toISOString(),
    timeZone,
  };
}

function stringifyBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body ?? "");
}
