import {
  getVacation,
  updateVacation,
} from "../../../../messaging/providers/gmail/client.js";
import type { GmailVacationSettings } from "../../../../messaging/providers/gmail/types.js";
import { resolveOAuthConnection } from "../../../../oauth/connection-resolver.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const account = input.account as string | undefined;
  const action = input.action as string;

  if (!action) {
    return err("action is required (get, enable, or disable).");
  }

  try {
    const connection = await resolveOAuthConnection("google", {
      account,
    });
    switch (action) {
      case "get": {
        const settings = await getVacation(connection);
        return ok(JSON.stringify(settings, null, 2));
      }

      case "enable": {
        const message = input.message as string;
        if (!message)
          return err("message is required when enabling vacation responder.");

        const settings: GmailVacationSettings = {
          enableAutoReply: true,
          responseSubject: (input.subject as string) ?? "Out of Office",
          responseBodyPlainText: message,
          restrictToContacts: (input.restrict_to_contacts as boolean) ?? false,
          restrictToDomain: (input.restrict_to_domain as boolean) ?? false,
        };

        if (input.start_time) settings.startTime = String(input.start_time);
        if (input.end_time) settings.endTime = String(input.end_time);

        const updated = await updateVacation(connection, settings);
        return ok(
          `Vacation responder enabled.\n${JSON.stringify(updated, null, 2)}`,
        );
      }

      case "disable": {
        await updateVacation(connection, { enableAutoReply: false });
        return ok("Vacation responder disabled.");
      }

      default:
        return err(`Unknown action "${action}". Use get, enable, or disable.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
