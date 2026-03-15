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
  const timeMin = input.time_min as string;
  const timeMax = input.time_max as string;
  const calendarIds = (input.calendar_ids as string[]) ?? ["primary"];
  const timezone = input.timezone as string | undefined;

  const connection = await getCalendarConnection(account);
  const result = await calendar.freeBusy(connection, {
    timeMin,
    timeMax,
    timeZone: timezone,
    items: calendarIds.map((id) => ({ id })),
  });

  return ok(JSON.stringify(result, null, 2));
}
