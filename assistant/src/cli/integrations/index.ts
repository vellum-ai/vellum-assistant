import type { Command } from "commander";

import { registerTelegramSubcommand } from "./telegram.js";
import { registerTwilioSubcommand } from "./twilio.js";
import { registerVoiceSubcommand } from "./voice.js";

export {
  gatewayGet,
  gatewayPost,
  runRead,
  shouldOutputJson,
  toQueryString,
  writeOutput,
} from "./utils.js";

export function registerIntegrationsCommand(program: Command): void {
  const integrations = program
    .command("integrations")
    .description("Read integration configuration and readiness status")
    .option("--json", "Machine-readable compact JSON output");

  integrations.addHelpText(
    "after",
    `
Reads integration configuration and readiness from shared assistant services.
Some subcommands query the running assistant gateway (\`telegram\`);
others read local config or call the underlying provider directly (\`twilio\`, \`voice\`).

Integration categories:
  twilio       Twilio voice credential and phone number status
  telegram     Telegram bot configuration and webhook status
  voice        Voice/call readiness and ElevenLabs voice ID (config-only)

Examples:
  $ assistant integrations twilio config
  $ assistant integrations twilio numbers --json
  $ assistant integrations telegram config`,
  );

  registerTwilioSubcommand(integrations);
  registerTelegramSubcommand(integrations);
  registerVoiceSubcommand(integrations);
}
