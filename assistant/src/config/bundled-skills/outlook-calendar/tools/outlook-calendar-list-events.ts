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
  const calendarId = input.calendar_id as string | undefined;
  const timeMin = (input.time_min as string) ?? new Date().toISOString();
  const timeMax = input.time_max as string | undefined;
  const maxResults = Math.min((input.max_results as number) ?? 25, 250);
  const query = input.query as string | undefined;
  const orderBy = input.order_by as string | undefined;

  const connection = await getCalendarConnection(account);

  // Build OData $filter from time range and optional user query
  const filterParts: string[] = [];
  if (timeMin) {
    filterParts.push(`start/dateTime ge '${timeMin}'`);
  }
  if (timeMax) {
    filterParts.push(`start/dateTime le '${timeMax}'`);
  }
  if (query) {
    filterParts.push(query);
  }
  const filter = filterParts.length > 0 ? filterParts.join(" and ") : undefined;

  const result = await calendar.listEvents(connection, calendarId, {
    filter,
    top: maxResults,
    orderby: orderBy,
  });

  if (!result.value?.length) {
    return ok("No events found in the specified time range.");
  }

  return ok(JSON.stringify(result, null, 2));
}
