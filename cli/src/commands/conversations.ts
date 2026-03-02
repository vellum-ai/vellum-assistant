import { existsSync, readFileSync } from "node:fs";

import {
  findConversationKey,
  importConversations,
  listConversationKeys,
  listConversations,
  type ImportableConversation,
} from "../lib/conversation-store.js";

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDate(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum conversations <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  list [--limit N]               List conversations (default limit 50)",
  );
  console.log(
    "  import <file.json>             Import conversations from a JSON file",
  );
  console.log("  keys list [--limit N]          List conversation keys");
  console.log("  keys check <key>               Check whether a key exists");
  console.log("");
  console.log("Options:");
  console.log("  --json    Machine-readable JSON output");
  console.log("");
  console.log("Import file format (JSON array of conversation objects):");
  console.log('  [{ "sourceKey": "...", "title": "...", "createdAt": <ms>,');
  console.log(
    '     "updatedAt": <ms>, "messages": [{ "role": "user"|"assistant",',
  );
  console.log('     "content": "...", "createdAt": <ms> }] }]');
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function handleList(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const limit = parseInt(getFlagValue(args, "--limit") ?? "50", 10);

  const rows = listConversations(limit);

  if (json) {
    console.log(JSON.stringify({ ok: true, conversations: rows }));
    return;
  }

  if (rows.length === 0) {
    console.log("No conversations found.");
    return;
  }

  console.log(`Conversations (${rows.length}):\n`);
  for (const c of rows) {
    console.log(`  ID:      ${c.id}`);
    console.log(`  Title:   ${c.title ?? "(untitled)"}`);
    console.log(`  Created: ${formatDate(c.createdAt)}`);
    console.log(`  Updated: ${formatDate(c.updatedAt)}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Subcommand: import
// ---------------------------------------------------------------------------

async function handleImport(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error(
      "Usage: vellum conversations import <file.json> [--json]",
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(filePath)) {
    const msg = `File not found: ${filePath}`;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    const msg = `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`;
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(data)) {
    const msg = "Import file must contain a JSON array of conversation objects.";
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = importConversations(data as ImportableConversation[]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }

  console.log(
    `Imported ${result.importedCount} conversation(s) with ${result.messageCount} message(s).`,
  );
  if (result.skippedCount > 0) {
    console.log(
      `Skipped ${result.skippedCount} already-imported conversation(s).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommand: keys
// ---------------------------------------------------------------------------

async function handleKeys(args: string[]): Promise<void> {
  const json = hasFlag(args, "--json");
  const keysSubcommand = args[0];

  if (!keysSubcommand || keysSubcommand === "--help" || keysSubcommand === "-h") {
    console.log("Usage: vellum conversations keys <subcommand> [options]");
    console.log("");
    console.log("Subcommands:");
    console.log("  list [--limit N]   List all conversation keys");
    console.log("  check <key>        Check whether a key exists");
    return;
  }

  switch (keysSubcommand) {
    case "list": {
      const limit = parseInt(getFlagValue(args, "--limit") ?? "100", 10);
      const rows = listConversationKeys(limit);

      if (json) {
        console.log(JSON.stringify({ ok: true, keys: rows }));
        return;
      }

      if (rows.length === 0) {
        console.log("No conversation keys found.");
        return;
      }

      console.log(`Conversation keys (${rows.length}):\n`);
      for (const k of rows) {
        console.log(`  Key:            ${k.conversationKey}`);
        console.log(`  Conversation:   ${k.conversationId}`);
        console.log(`  Recorded:       ${formatDate(k.createdAt)}`);
        console.log("");
      }
      break;
    }

    case "check": {
      const key = args[1];
      if (!key || key.startsWith("--")) {
        console.error("Usage: vellum conversations keys check <key>");
        process.exitCode = 1;
        return;
      }

      const row = findConversationKey(key);

      if (json) {
        if (row) {
          console.log(JSON.stringify({ ok: true, exists: true, key: row }));
        } else {
          console.log(JSON.stringify({ ok: true, exists: false }));
        }
        return;
      }

      if (row) {
        console.log(`Key "${key}" exists.`);
        console.log(`  Conversation: ${row.conversationId}`);
        console.log(`  Recorded:     ${formatDate(row.createdAt)}`);
      } else {
        console.log(`Key "${key}" not found.`);
      }
      break;
    }

    default: {
      console.error(`Unknown keys subcommand: ${keysSubcommand}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function conversations(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "list":
      await handleList(args.slice(1));
      break;

    case "import":
      await handleImport(args.slice(1));
      break;

    case "keys":
      await handleKeys(args.slice(1));
      break;

    default:
      console.error(`Unknown conversations subcommand: ${subcommand}`);
      printUsage();
      process.exitCode = 1;
  }
}
