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

  const start = isAllDay
    ? {
        dateTime: `${startRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: startRaw, timeZone: timezone ?? "UTC" };

  const end = isAllDay
    ? {
        dateTime: `${endRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: endRaw, timeZone: timezone ?? "UTC" };

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
