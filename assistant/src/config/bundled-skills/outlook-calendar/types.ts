/** Microsoft Graph date+time pair (always includes time zone). */
export interface OutlookDateTimeZone {
  dateTime: string;
  timeZone: string;
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
