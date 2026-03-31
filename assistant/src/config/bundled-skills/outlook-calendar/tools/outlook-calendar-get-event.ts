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

  const connection = await getCalendarConnection(account);
  const event = await calendar.getEvent(connection, eventId);
  return ok(JSON.stringify(event, null, 2));
}
