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

  const connection = await getCalendarConnection(account);

  // Fetch the event to get context for the response message
  const event = await calendar.getEvent(connection, eventId);

  // If the user is the organizer, no RSVP is needed
  if (event.responseStatus?.response === "organizer") {
    return ok("You are the organizer of this event. No RSVP needed.");
  }

  // Send RSVP via the dedicated Microsoft Graph endpoint, notifying the organizer
  await calendar.rsvpEvent(connection, eventId, response, true);

  const responseLabel =
    response === "accepted"
      ? "Accepted"
      : response === "declined"
        ? "Declined"
        : "Tentatively accepted";
  return ok(`${responseLabel} the event "${event.subject ?? eventId}".`);
}
