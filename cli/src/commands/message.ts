/**
 * `vellum message <assistant> <message>`
 *
 * Send a message to a running assistant via its runtime HTTP API and
 * print the raw JSON response.  This is a fire-and-send command — it
 * does NOT subscribe to SSE events (use `vellum events` for that).
 */

import {
  findAssistantByName,
  getActiveAssistant,
  loadLatestAssistant,
} from "../lib/assistant-config.js";
import { GATEWAY_PORT } from "../lib/constants.js";
import { loadGuardianToken } from "../lib/guardian-token.js";
import { sendMessage } from "../lib/assistant-runtime-client.js";

const FALLBACK_RUNTIME_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

function printUsage(): void {
  console.log(`vellum message - Send a message to a running assistant

USAGE:
    vellum message [assistant] <message>

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)
    <message>      Message content to send

EXAMPLES:
    vellum message "hello"
    vellum message my-assistant "ping"
`);
}

export async function message(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  let assistantName: string | undefined;
  let messageContent: string | undefined;

  if (args.length >= 2) {
    // vellum message <assistant> <message>
    assistantName = args[0];
    messageContent = args[1];
  } else if (args.length === 1) {
    // vellum message <message>  (uses active/latest assistant)
    messageContent = args[0];
  }

  if (!messageContent) {
    console.error("Error: message content is required.");
    console.error("");
    printUsage();
    process.exit(1);
  }

  // Resolve the target assistant from the lockfile.
  let entry = assistantName ? findAssistantByName(assistantName) : null;

  if (assistantName && !entry) {
    console.error(`No assistant found with name '${assistantName}'.`);
    process.exit(1);
  }

  if (!entry) {
    const active = getActiveAssistant();
    if (active) {
      entry = findAssistantByName(active);
    }
  }

  if (!entry) {
    entry = loadLatestAssistant();
  }

  if (!entry) {
    console.error(
      "Error: no assistant found. Hatch one first with 'vellum hatch'.",
    );
    process.exit(1);
  }

  const runtimeUrl = (entry.runtimeUrl ?? FALLBACK_RUNTIME_URL).replace(
    /\/+$/,
    "",
  );
  const assistantId = entry.assistantId;
  const bearerToken =
    loadGuardianToken(assistantId)?.accessToken ?? entry.bearerToken;

  const result = await sendMessage(
    { runtimeUrl, assistantId, bearerToken },
    messageContent,
  );

  console.log(JSON.stringify(result, null, 2));
}
