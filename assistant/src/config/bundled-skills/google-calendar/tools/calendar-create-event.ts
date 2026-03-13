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
  const calendarId = (input.calendar_id as string) ?? "primary";

  // Determine if these are all-day events (date-only) or timed events
  const isAllDay = !startRaw.includes("T");

  const start = isAllDay
    ? { date: startRaw }
    : { dateTime: startRaw, timeZone: timezone };
  const end = isAllDay
    ? { date: endRaw }
    : { dateTime: endRaw, timeZone: timezone };

  const eventBody: Parameters<typeof calendar.createEvent>[1] = {
    summary,
    start,
    end,
  };

  if (description) eventBody.description = description;
  if (location) eventBody.location = location;
  if (attendees?.length) {
    eventBody.attendees = attendees.map((email) => ({ email }));
  }

  const connection = await getCalendarConnection(account);
  const event = await calendar.createEvent(connection, eventBody, calendarId);
  const link = event.htmlLink ? ` View it here: ${event.htmlLink}` : "";
  return ok(`Event created (ID: ${event.id}).${link}`);
}
