import {
  getAutoReplySettings,
  updateAutoReplySettings,
} from "../../../../messaging/providers/outlook/client.js";
import type { OutlookAutoReplySettings } from "../../../../messaging/providers/outlook/types.js";
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
    const connection = await resolveOAuthConnection("outlook", {
      account,
    });
    switch (action) {
      case "get": {
        const settings = await getAutoReplySettings(connection);
        return ok(JSON.stringify(settings, null, 2));
      }

      case "enable": {
        const internalMessage = input.internal_message as string;
        if (!internalMessage)
          return err("internal_message is required when enabling auto-reply.");

        const externalAudience = (input.external_audience as string) ?? "none";
        const startDate = input.start_date as string | undefined;
        const endDate = input.end_date as string | undefined;
        const timeZone =
          (input.time_zone as string) ??
          Intl.DateTimeFormat().resolvedOptions().timeZone;

        const isScheduled = !!(startDate && endDate);

        const settings: OutlookAutoReplySettings = {
          status: isScheduled ? "scheduled" : "alwaysEnabled",
          externalAudience: externalAudience as "none" | "contactsOnly" | "all",
          internalReplyMessage: internalMessage,
        };

        if (input.external_message) {
          settings.externalReplyMessage = input.external_message as string;
        }

        if (isScheduled) {
          settings.scheduledStartDateTime = {
            dateTime: startDate!,
            timeZone,
          };
          settings.scheduledEndDateTime = {
            dateTime: endDate!,
            timeZone,
          };
        }

        await updateAutoReplySettings(connection, settings);
        return ok("Auto-reply enabled.");
      }

      case "disable": {
        await updateAutoReplySettings(connection, {
          status: "disabled",
          externalAudience: "none",
        });
        return ok("Auto-reply disabled.");
      }

      default:
        return err(`Unknown action "${action}". Use get, enable, or disable.`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
