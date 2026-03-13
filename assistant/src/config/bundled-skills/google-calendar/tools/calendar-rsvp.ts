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
  const eventId = input.event_id as string;
  const response = input.response as "accepted" | "declined" | "tentative";
  const calendarId = (input.calendar_id as string) ?? "primary";

  const connection = getCalendarConnection(account);

  // First get the event to find the user's attendee entry
  const event = await calendar.getEvent(connection, eventId, calendarId);
  const selfAttendee = event.attendees?.find((a) => a.self);

  if (!selfAttendee) {
    // If the user is the organizer and not in the attendees list,
    // they don't need to RSVP
    if (event.organizer?.self) {
      return ok("You are the organizer of this event. No RSVP needed.");
    }
    return ok(
      "Could not find your attendee entry for this event. You may not be invited.",
    );
  }

  // Update the attendee's response status
  const updatedAttendees = event.attendees!.map((a) =>
    a.self ? { ...a, responseStatus: response } : a,
  );

  await calendar.patchEvent(
    connection,
    eventId,
    {
      attendees: updatedAttendees as Array<{
        email: string;
        responseStatus?: string;
      }>,
    },
    calendarId,
  );

  const responseLabel =
    response === "accepted"
      ? "Accepted"
      : response === "declined"
        ? "Declined"
        : "Tentatively accepted";
  return ok(`${responseLabel} the event "${event.summary ?? eventId}".`);
}
