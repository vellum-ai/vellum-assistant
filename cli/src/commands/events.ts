/**
 * `vellum events [assistant]`
 *
 * Subscribe to assistant events via the SSE endpoint and stream them
 * to stdout.  By default, events are rendered as human-readable
 * markdown.  Pass `--json` to emit one JSON object per event,
 * separated by newlines.
 */

import { extractFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import { getClientRegistrationHeaders } from "../lib/client-identity.js";

function printUsage(): void {
  console.log(`vellum events - Stream events from a running assistant

USAGE:
    vellum events [assistant] [options]

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)

OPTIONS:
    --conversation-key <key>  Scope to a single conversation
    --json                    Output raw JSON events (one per line)
    -h, --help                Show this help message

EXAMPLES:
    vellum events
    vellum events my-assistant
    vellum events --json
    vellum events --conversation-key my-thread
`);
}

interface AssistantEvent {
  id: string;
  assistantId: string;
  conversationId?: string;
  emittedAt: string;
  message: {
    type: string;
    text?: string;
    thinking?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    content?: string;
    message?: string;
    chunk?: string;
    conversationId?: string;
    [key: string]: unknown;
  };
}

/** Render an event as human-readable markdown to stdout. */
function renderMarkdown(event: AssistantEvent): void {
  const msg = event.message;
  switch (msg.type) {
    case "assistant_text_delta":
      process.stdout.write(msg.text ?? "");
      break;
    case "assistant_thinking_delta":
      process.stdout.write(msg.thinking ?? "");
      break;
    case "tool_use_start":
      console.log(`\n> **Tool call:** \`${msg.toolName}\``);
      if (msg.input && Object.keys(msg.input).length > 0) {
        console.log("```json");
        console.log(JSON.stringify(msg.input, null, 2));
        console.log("```");
      }
      break;
    case "tool_input_delta":
      process.stdout.write(msg.content ?? "");
      break;
    case "tool_result":
      if (msg.isError) {
        console.log(`\n> **Tool error** (\`${msg.toolName}\`): ${msg.result}`);
      } else {
        console.log(`\n> **Tool result** (\`${msg.toolName}\`): ${msg.result}`);
      }
      break;
    case "tool_output_chunk":
      process.stdout.write(msg.chunk ?? "");
      break;
    case "message_complete":
      console.log("\n");
      break;
    case "error":
      console.error(`\n**Error:** ${msg.message}`);
      break;
    case "user_message_echo":
      console.log(`\n**You:** ${msg.text}`);
      break;
    default:
      // Silently skip events that don't have a markdown representation
      // (e.g. heartbeat comments, activity states, etc.)
      break;
  }
}

export async function events(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const jsonOutput = rawArgs.includes("--json");
  let args = rawArgs.filter((a) => a !== "--json");

  const [conversationKey, filteredArgs] = extractFlag(
    args,
    "--conversation-key",
  );
  args = filteredArgs;

  const assistantId = args[0];

  const client = new AssistantClient({ assistantId });

  // Use an explicit AbortController so we can clean up on SIGINT
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    process.exit(0);
  });

  const query: Record<string, string> = {};
  if (conversationKey) {
    query.conversationKey = conversationKey;
  }

  for await (const event of client.stream<AssistantEvent>("/events", {
    signal: controller.signal,
    query,
    headers: getClientRegistrationHeaders(),
  })) {
    if (jsonOutput) {
      console.log(JSON.stringify(event));
    } else {
      renderMarkdown(event);
    }
  }
}
