import { loadLatestAssistant } from "../lib/assistant-config";
import { GATEWAY_PORT } from "../lib/constants.js";

// ---------------------------------------------------------------------------
// Gateway API client
// ---------------------------------------------------------------------------

function getGatewayUrl(): string {
  const entry = loadLatestAssistant();
  if (entry?.runtimeUrl) return entry.runtimeUrl;
  return `http://localhost:${GATEWAY_PORT}`;
}

function getBearerToken(): string | undefined {
  const entry = loadLatestAssistant();
  return entry?.bearerToken;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getBearerToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiGet(path: string): Promise<unknown> {
  const url = `${getGatewayUrl()}/v1/${path}`;
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const url = `${getGatewayUrl()}/v1/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContactChannel {
  type: string;
  address: string;
  isPrimary: boolean;
}

interface Contact {
  id: string;
  displayName: string;
  notes: string | null;
  lastInteraction: number | null;
  interactionCount: number;
  channels: ContactChannel[];
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function formatContact(c: Contact): string {
  const lines = [
    `  ID:           ${c.id}`,
    `  Name:         ${c.displayName}`,
    `  Notes:        ${c.notes ?? "(none)"}`,
    `  Interactions: ${c.interactionCount}`,
  ];
  if (c.lastInteraction) {
    lines.push(`  Last seen:    ${new Date(c.lastInteraction).toISOString()}`);
  }
  if (c.channels.length > 0) {
    lines.push("  Channels:");
    for (const ch of c.channels) {
      const primary = ch.isPrimary ? " (primary)" : "";
      lines.push(`    - ${ch.type}: ${ch.address}${primary}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum contacts <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log("  list [--limit N] [--role ROLE]  List all contacts");
  console.log("  get <id>                       Get a contact by ID");
  console.log("  merge <keepId> <mergeId>       Merge two contacts");
  console.log("");
  console.log("Options:");
  console.log("  --json    Machine-readable JSON output");
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function contacts(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];
  const json = hasFlag(args, "--json");

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "list": {
      const limit = getFlagValue(args, "--limit") ?? "50";
      const role = getFlagValue(args, "--role");
      const query = `contacts?limit=${limit}${role ? `&role=${encodeURIComponent(role)}` : ""}`;
      const data = (await apiGet(query)) as {
        ok: boolean;
        contacts: Contact[];
      };

      if (json) {
        console.log(JSON.stringify(data));
        return;
      }

      if (data.contacts.length === 0) {
        console.log("No contacts found.");
        return;
      }

      console.log(`Contacts (${data.contacts.length}):\n`);
      for (const c of data.contacts) {
        console.log(formatContact(c) + "\n");
      }
      break;
    }

    case "get": {
      const id = args[1];
      if (!id || id.startsWith("--")) {
        console.error("Usage: vellum contacts get <id>");
        process.exit(1);
      }

      try {
        const data = (await apiGet(`contacts/${encodeURIComponent(id)}`)) as {
          ok: boolean;
          contact: Contact;
        };

        if (json) {
          console.log(JSON.stringify(data));
        } else {
          console.log(formatContact(data.contact));
        }
      } catch {
        if (json) {
          console.log(
            JSON.stringify({
              ok: false,
              error: `Contact "${id}" not found`,
            }),
          );
        } else {
          console.error(`Contact "${id}" not found.`);
        }
        process.exitCode = 1;
      }
      break;
    }

    case "merge": {
      const keepId = args[1];
      const mergeId = args[2];
      if (
        !keepId ||
        !mergeId ||
        keepId.startsWith("--") ||
        mergeId.startsWith("--")
      ) {
        console.error("Usage: vellum contacts merge <keepId> <mergeId>");
        process.exit(1);
      }

      try {
        const data = (await apiPost("contacts/merge", {
          keepId,
          mergeId,
        })) as { ok: boolean; contact: Contact };

        if (json) {
          console.log(JSON.stringify(data));
        } else {
          console.log(`Merged contact "${mergeId}" into "${keepId}".\n`);
          console.log(formatContact(data.contact));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
      break;
    }

    default: {
      console.error(`Unknown contacts subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
