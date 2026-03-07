import type { Command } from "commander";

import {
  getTwilioCredentials,
  hasTwilioCredentials,
  listIncomingPhoneNumbers,
} from "../../calls/twilio-rest.js";
import { loadRawConfig } from "../../config/loader.js";
import { asRecord, runRead } from "./utils.js";

function readTwilioConfig(): {
  success: true;
  hasCredentials: boolean;
  accountSid?: string;
  phoneNumber?: string;
} {
  const hasCredentials = hasTwilioCredentials();
  const accountSid = hasCredentials
    ? getTwilioCredentials().accountSid
    : undefined;
  const raw = loadRawConfig();
  const twilio = asRecord(raw.twilio);
  const phoneNumber =
    typeof twilio.phoneNumber === "string" ? twilio.phoneNumber.trim() : "";

  return {
    success: true,
    hasCredentials,
    accountSid: accountSid || undefined,
    phoneNumber: phoneNumber || undefined,
  };
}

async function readTwilioNumbers(): Promise<unknown> {
  if (!hasTwilioCredentials()) {
    return {
      success: false,
      hasCredentials: false,
      error: "Twilio credentials not configured. Set credentials first.",
    };
  }

  const { accountSid, authToken } = getTwilioCredentials();
  const numbers = await listIncomingPhoneNumbers(accountSid, authToken);

  return {
    success: true,
    hasCredentials: true,
    numbers,
  };
}

export function registerTwilioSubcommand(integrations: Command): void {
  const twilio = integrations
    .command("twilio")
    .description("Twilio voice integration status");

  twilio.addHelpText(
    "after",
    `
Reads Twilio integration state from the same assistant-side services used by
the runtime routes. These commands do not require the gateway to be running.
\`config\` only reads local assistant state; \`numbers\` also calls the Twilio REST API.

Examples:
  $ assistant integrations twilio config
  $ assistant integrations twilio numbers
  $ assistant integrations twilio numbers --json`,
  );

  twilio
    .command("config")
    .description("Get Twilio integration configuration status")
    .addHelpText(
      "after",
      `
Arguments:
  (none)

Returns whether Twilio credentials are configured and whether a phone number is
assigned in the assistant config. Reads local assistant state only; it
does not call the gateway or Twilio.

Examples:
  $ assistant integrations twilio config
  $ assistant integrations twilio config --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readTwilioConfig());
    });

  twilio
    .command("numbers")
    .description("Get Twilio phone numbers")
    .addHelpText(
      "after",
      `
Arguments:
  (none)

Lists incoming Twilio phone numbers for the configured account. Returns
\`success: false\` with \`hasCredentials: false\` when credentials are missing.
Calls the Twilio REST API directly; it does not proxy through the gateway.

Examples:
  $ assistant integrations twilio numbers
  $ assistant integrations twilio numbers --json`,
    )
    .action(async (_opts: unknown, cmd: Command) => {
      await runRead(cmd, async () => readTwilioNumbers());
    });
}
