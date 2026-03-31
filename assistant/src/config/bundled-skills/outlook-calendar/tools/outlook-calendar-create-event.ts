import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import * as calendar from "../calendar-client.js";
import { getCalendarConnection, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const summary = input.summary as string;
  const startRaw = input.start as string;
  const endRaw = input.end as string;
  const description = input.description as string | undefined;
  const location = input.location as string | undefined;
  const attendees = input.attendees as string[] | undefined;
  const timezone = input.timezone as string | undefined;
  const calendarId = input.calendar_id as string | undefined;

  // Detect all-day events: if start string does not contain "T", treat as all-day
  const isAllDay = !startRaw.includes("T");

  // Determine the timeZone to send. If the caller provided an explicit IANA
  // timezone, always use it.  Otherwise, only fall back to UTC when the
  // dateTime string does NOT already carry an offset (e.g. "-05:00" or "Z").
  // Sending timeZone: "UTC" alongside a dateTime that contains a different
  // offset would cause Microsoft Graph to ignore the offset and interpret the
  // time as UTC, creating events at the wrong wall-clock time.
  const hasOffset = (dt: string) => /[Zz]|[+-]\d{2}:\d{2}$/.test(dt);
  const resolveTimeZone = (dt: string) =>
    timezone ?? (hasOffset(dt) ? undefined : "UTC");

  const start = isAllDay
    ? {
        dateTime: `${startRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: startRaw, timeZone: resolveTimeZone(startRaw) };

  const end = isAllDay
    ? {
        dateTime: `${endRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: endRaw, timeZone: resolveTimeZone(endRaw) };

  const eventBody: Parameters<typeof calendar.createEvent>[1] = {
    subject: summary,
    start,
    end,
    isAllDay,
  };

  if (description) {
    eventBody.body = { contentType: "text", content: description };
  }
  if (location) {
    eventBody.location = { displayName: location };
  }
  if (attendees?.length) {
    eventBody.attendees = attendees.map((email) => ({
      emailAddress: { address: email },
      type: "required" as const,
    }));
  }

  const connection = await getCalendarConnection(account);
  const event = await calendar.createEvent(connection, eventBody, calendarId);
  return ok(
    `Event created (ID: ${event.id}).${event.webLink ? ` View it here: ${event.webLink}` : ""}`,
  );
}
