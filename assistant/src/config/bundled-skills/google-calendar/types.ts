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
