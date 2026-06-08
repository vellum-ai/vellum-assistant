/**
 * `vellum message <assistant> <message>`
 *
 * Send a message to a running assistant via its runtime HTTP API and
 * print the result.  This is a fire-and-send command — it does NOT
 * subscribe to SSE events (use `vellum events` for that).
 */

import { readFileSync } from "node:fs";

import { extractFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";

function printUsage(): void {
  console.log(`vellum message - Send a message to a running assistant

USAGE:
    vellum message [assistant] <message>
    vellum message [assistant] --file <path>

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)
    <message>      Message content to send (omit when using --file)

OPTIONS:
    --file <path>             Read message content from a file ("-" reads stdin)
    --conversation-key <key>  Conversation key (default: stable key per channel/interface)
    --json                    Output raw JSON response

EXAMPLES:
    vellum message "hello"
    vellum message my-assistant "ping"
    vellum message --file prompt.txt
    vellum message my-assistant --file prompt.txt
    cat prompt.txt | vellum message --file -
    vellum message --conversation-key my-thread "hello"
    vellum message --json "hello"
`);
}

interface ParsedMessageArgs {
  assistantId?: string;
  conversationKey?: string;
  jsonOutput: boolean;
  /** Path to read message content from, or undefined for an inline message. */
  filePath?: string;
  /** Inline message content, present only when --file was not used. */
  inlineMessage?: string;
}

type ParseResult =
  | { ok: true; value: ParsedMessageArgs }
  | { ok: false; error: string };

/**
 * Parse `vellum message` arguments. Pure: does no I/O and never exits, so the
 * positional/flag rules can be unit-tested. File reading and validation of the
 * resolved content happen in {@link message}.
 */
export function parseMessageArgs(rawArgs: string[]): ParseResult {
  const jsonOutput = rawArgs.includes("--json");
  let args = rawArgs.filter((a) => a !== "--json");

  const [conversationKey, afterConversationKey] = extractFlag(
    args,
    "--conversation-key",
  );
  args = afterConversationKey;

  const fileFlagPresent = args.includes("--file");
  const [filePath, afterFile] = extractFlag(args, "--file");
  args = afterFile;

  // `extractFlag` strips a trailing value-less `--file`, which would otherwise
  // make the next positional masquerade as the message content. Reject it.
  if (fileFlagPresent && filePath === undefined) {
    return { ok: false, error: "--file requires a path argument." };
  }

  if (filePath !== undefined) {
    // vellum message [assistant] --file <path>
    // The message content comes from the file, so any remaining positional
    // arg is the assistant target.
    if (args.length >= 2) {
      return {
        ok: false,
        error: "--file cannot be combined with an inline message argument.",
      };
    }
    return {
      ok: true,
      value: { assistantId: args[0], conversationKey, jsonOutput, filePath },
    };
  }

  if (args.length >= 2) {
    // vellum message <assistant> <message>
    return {
      ok: true,
      value: {
        assistantId: args[0],
        conversationKey,
        jsonOutput,
        inlineMessage: args[1],
      },
    };
  }
  if (args.length === 1) {
    // vellum message <message>  (uses active/latest assistant)
    return {
      ok: true,
      value: { conversationKey, jsonOutput, inlineMessage: args[0] },
    };
  }

  return { ok: false, error: "message content is required." };
}

function exitWithUsage(error: string): never {
  console.error(`Error: ${error}`);
  console.error("");
  printUsage();
  process.exit(1);
}

export async function message(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const parsed = parseMessageArgs(rawArgs);
  if (!parsed.ok) {
    exitWithUsage(parsed.error);
  }

  const { assistantId, conversationKey, jsonOutput, filePath, inlineMessage } =
    parsed.value;

  let messageContent: string;
  if (filePath !== undefined) {
    try {
      messageContent = readFileSync(filePath === "-" ? 0 : filePath, "utf-8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `Error: could not read message file "${filePath}": ${reason}`,
      );
      process.exit(1);
    }
    if (messageContent.length === 0) {
      exitWithUsage(`message file "${filePath}" is empty.`);
    }
  } else {
    messageContent = inlineMessage ?? "";
  }

  const client = new AssistantClient({ assistantId });

  const payload: Record<string, string> = {
    content: messageContent,
    sourceChannel: "vellum",
    interface: "cli",
  };
  if (conversationKey) {
    payload.conversationKey = conversationKey;
  }

  const response = await client.post("/messages/", payload);

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
