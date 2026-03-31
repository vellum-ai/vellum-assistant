import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import * as calendar from "../calendar-client.js";
import { err, getCalendarConnection, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const timeMin = input.time_min as string;
  const timeMax = input.time_max as string;
  let schedules = (input.schedules as string[] | undefined) ?? [];
  const timezone = (input.timezone as string | undefined) ?? "UTC";

  const connection = await getCalendarConnection(account);

  if (schedules.length === 0) {
    const resp = await connection.request({
      method: "GET",
      path: "/v1.0/me",
    });
    if (resp.status < 200 || resp.status >= 300) {
      return err(
        "Failed to retrieve your Microsoft profile. Cannot determine your email for availability lookup.",
      );
    }
    const body = resp.body as Record<string, unknown>;
    const email =
      (body.mail as string | undefined) ??
      (body.userPrincipalName as string | undefined);
    if (email) {
      schedules = [email];
    }
  }

  if (schedules.length === 0) {
    return err(
      "No schedules provided and could not determine your email address from your Microsoft profile. " +
        "Please provide at least one email address in the schedules parameter.",
    );
  }

  const result = await calendar.getSchedule(connection, {
    schedules,
    startTime: { dateTime: timeMin, timeZone: timezone },
    endTime: { dateTime: timeMax, timeZone: timezone },
  });

  return ok(JSON.stringify(result, null, 2));
}
