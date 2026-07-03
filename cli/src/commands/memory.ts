/**
 * `vellum memory <subcommand>`
 *
 * Manage the assistant's long-term memory graph from the command line.
 *
 * Subcommands:
 *   delete <content>                   Soft-delete a memory node by content
 *   update <old_content> <new_content> Update a memory node in place
 */

import { extractAssistantFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
} from "../lib/assistant-config.js";

function printHelp(): void {
  console.log("Usage: vellum memory <subcommand> [options]");
  console.log("");
  console.log("Manage the assistant's long-term memory graph.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  delete <content>                    Remove a memory node matching <content>",
  );
  console.log(
    "  update <old_content> <new_content>  Correct a memory node in place",
  );
  console.log("");
  console.log("Arguments:");
  console.log(
    "  <content>       The text of the memory to match (exact or substring match)",
  );
  console.log("  <old_content>   The current text of the memory to update");
  console.log("  <new_content>   The replacement text");
  console.log("");
  console.log("Options:");
  console.log(
    "  --assistant <name>  Target a specific assistant (display name or ID)",
  );
  console.log("  --help, -h          Show this help");
  console.log("");
  console.log("Examples:");
  console.log('  $ vellum memory delete "I live in Kigali"');
  console.log('  $ vellum memory update "I live in Kigali" "I live in Nairobi"');
  console.log(
    '  $ vellum memory delete "old fact" --assistant my-assistant',
  );
}

function createClient(assistantName?: string): AssistantClient {
  let assistantId: string | undefined;
  if (assistantName) {
    const result = lookupAssistantByIdentifier(assistantName);
    if (result.status !== "found") {
      throw new Error(formatAssistantLookupError(assistantName, result));
    }
    assistantId = result.entry.assistantId;
  }
  try {
    return new AssistantClient(assistantId ? { assistantId } : undefined);
  } catch {
    throw new Error(
      assistantName
        ? `No assistant found matching '${assistantName}'.`
        : "No assistant found. Hatch one with 'vellum hatch' first.",
    );
  }
}

function rethrowFetchError(err: unknown): never {
  if (
    err instanceof TypeError &&
    (err.message.includes("fetch") || err.message.includes("connect"))
  ) {
    throw new Error(
      "Could not reach the assistant. Is it running? Try 'vellum wake'.",
    );
  }
  throw err;
}

async function memoryDelete(
  content: string,
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.post("/memory/delete", { content });
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to delete memory: HTTP ${res.status} ${body}`.trim(),
    );
  }
  const data = (await res.json()) as { message: string };
  console.log(data.message);
}

async function memoryUpdate(
  oldContent: string,
  newContent: string,
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.post("/memory/update", {
      old_content: oldContent,
      new_content: newContent,
    });
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to update memory: HTTP ${res.status} ${body}`.trim(),
    );
  }
  const data = (await res.json()) as { message: string };
  console.log(data.message);
}

export async function memory(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const assistantName = extractAssistantFlag(args);

  const sub = args[0];

  if (!sub) {
    printHelp();
    return;
  }

  if (sub === "delete") {
    const content = args.slice(1).join(" ").trim();
    if (!content) {
      console.error("Error: content argument is required.");
      console.error("Usage: vellum memory delete <content>");
      process.exit(1);
    }
    await memoryDelete(content, assistantName);
    return;
  }

  if (sub === "update") {
    const rest = args.slice(1);
    if (rest.length < 2) {
      console.error(
        "Error: old_content and new_content arguments are required.",
      );
      console.error(
        "Usage: vellum memory update <old_content> <new_content>",
      );
      process.exit(1);
    }
    const oldContent = rest[0];
    const newContent = rest.slice(1).join(" ");
    await memoryUpdate(oldContent, newContent, assistantName);
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  console.error("");
  printHelp();
  process.exit(1);
}
