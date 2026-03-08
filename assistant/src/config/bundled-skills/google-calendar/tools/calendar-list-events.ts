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
  const calendarId = (input.calendar_id as string) ?? "primary";
  const timeMin = (input.time_min as string) ?? new Date().toISOString();
  const timeMax = input.time_max as string | undefined;
  const maxResults = Math.min((input.max_results as number) ?? 25, 250);
  const query = input.query as string | undefined;
  const singleEvents = (input.single_events as boolean) ?? true;
  const orderBy = input.order_by as "startTime" | "updated" | undefined;

  return withCalendarToken(async (token) => {
    const result = await calendar.listEvents(token, calendarId, {
      timeMin,
      timeMax,
      maxResults,
      query,
      singleEvents,
      orderBy,
    });

    if (!result.items?.length) {
      return ok("No events found in the specified time range.");
    }

    return ok(JSON.stringify(result, null, 2));
  });
}
