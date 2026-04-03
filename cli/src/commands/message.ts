/**
 * `vellum message <assistant> <message>`
 *
 * Send a message to a running assistant via its runtime HTTP API and
 * print the result.  This is a fire-and-send command — it does NOT
 * subscribe to SSE events (use `vellum events` for that).
 */

import { AssistantClient } from "../lib/assistant-client.js";

function printUsage(): void {
  console.log(`vellum message - Send a message to a running assistant

USAGE:
    vellum message [assistant] <message>

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)
    <message>      Message content to send

OPTIONS:
    --json         Output raw JSON response

EXAMPLES:
    vellum message "hello"
    vellum message my-assistant "ping"
    vellum message --json "hello"
`);
}

export async function message(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const jsonOutput = rawArgs.includes("--json");
  const args = rawArgs.filter((a) => a !== "--json");

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

  const client = new AssistantClient(assistantName);

  const response = await client.post("/messages/", {
    conversationKey: client.assistantId,
    content: messageContent,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${body || response.statusText}`,
    );
    process.exit(1);
  }

  const result = (await response.json()) as {
    accepted: boolean;
    messageId: string;
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.accepted) {
      console.log(`Message accepted (id: ${result.messageId})`);
    } else {
      console.log(`Message rejected (id: ${result.messageId})`);
    }
  }
}
