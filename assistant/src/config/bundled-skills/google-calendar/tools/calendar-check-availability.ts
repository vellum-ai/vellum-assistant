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
  const timeMin = input.time_min as string;
  const timeMax = input.time_max as string;
  const calendarIds = (input.calendar_ids as string[]) ?? ["primary"];
  const timezone = input.timezone as string | undefined;

  return withCalendarToken(async (token) => {
    const result = await calendar.freeBusy(token, {
      timeMin,
      timeMax,
      timeZone: timezone,
      items: calendarIds.map((id) => ({ id })),
    });

    return ok(JSON.stringify(result, null, 2));
  });
}
