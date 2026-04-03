/**
 * `vellum events [assistant]`
 *
 * Subscribe to assistant events via the SSE endpoint and stream them
 * to stdout.  By default, events are rendered as human-readable
 * markdown.  Pass `--json` to emit one JSON object per event,
 * separated by newlines.
 */

import { AssistantClient } from "../lib/assistant-client.js";

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

/** Extract a named flag's value from an arg list, returning [value, remaining]. */
function extractFlag(
  args: string[],
  flag: string,
): [string | undefined, string[]] {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return [undefined, args.filter((a) => a !== flag)];
  }
  const value = args[idx + 1]!;
  const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return [value, remaining];
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

  const queryParams = new URLSearchParams();
  if (conversationKey) {
    queryParams.set("conversationKey", conversationKey);
  }
  const queryString = queryParams.toString();
  const path = `/events${queryString ? `?${queryString}` : ""}`;

  // Use an explicit AbortController so we can clean up on SIGINT
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    process.exit(0);
  });

  const response = await client.get(path, {
    signal: controller.signal,
    headers: { Accept: "text/event-stream" },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${body || response.statusText}`,
    );
    process.exit(1);
  }

  if (!response.body) {
    console.error("Error: No response body received.");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete SSE frames (delimited by double newlines)
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      // Skip heartbeat comments and empty frames
      if (!frame.trim() || frame.startsWith(":")) continue;

      // Parse SSE fields
      let data: string | undefined;
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }

      if (!data) continue;

      let event: AssistantEvent;
      try {
        event = JSON.parse(data) as AssistantEvent;
      } catch {
        continue;
      }

      if (jsonOutput) {
        console.log(JSON.stringify(event));
      } else {
        renderMarkdown(event);
      }
    }
  }
}
