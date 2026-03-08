import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import * as calendar from "../calendar-client.js";
import { ok, withCalendarToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const eventId = input.event_id as string;
  const calendarId = (input.calendar_id as string) ?? "primary";

  return withCalendarToken(async (token) => {
    const event = await calendar.getEvent(token, eventId, calendarId);
    return ok(JSON.stringify(event, null, 2));
  });
}
