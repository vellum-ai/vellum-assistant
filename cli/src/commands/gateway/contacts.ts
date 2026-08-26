/**
 * `vellum gateway contacts` operator surface.
 *
 * Host-side writes and reads against the running gateway's HTTP
 * contact control plane. Use this from the host. Inside the gateway
 * container, `gateway contacts` talks to the same store over IPC.
 */

import { resolveTargetAssistant } from "../../lib/assistant-config.js";
import {
  loadGuardianToken,
  refreshGuardianTokenResult,
} from "../../lib/guardian-token.js";
import { loopbackSafeFetch } from "../../lib/loopback-fetch.js";

const THRESHOLDS = ["none", "low", "medium", "high", "inherit"] as const;
type ThresholdFlag = (typeof THRESHOLDS)[number];

export type ParsedGatewayContactsCommand =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "list";
      json: boolean;
      role?: string;
      assistantId?: string;
    }
  | { kind: "get"; contactId: string; json: boolean; assistantId?: string }
  | {
      kind: "set-threshold";
      contactId: string;
      threshold: "none" | "low" | "medium" | "high" | null;
      json: boolean;
      assistantId?: string;
    };

function isThresholdFlag(value: string): value is ThresholdFlag {
  return (THRESHOLDS as readonly string[]).includes(value);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    return "";
  }
  return value;
}

export function parseGatewayContactsArgs(
  args: string[],
): ParsedGatewayContactsCommand {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }

  const json = args.includes("--json");
  const withoutJson = args.filter((arg) => arg !== "--json");
  const assistantId = readFlag(withoutJson, "--assistant");
  if (assistantId === "") {
    return { kind: "error", message: "--assistant requires a value" };
  }
  const positional = withoutJson.filter(
    (arg, index, all) => arg !== "--assistant" && all[index - 1] !== "--assistant",
  );
  const subcommand = positional[0];

  if (subcommand === "list") {
    const role = readFlag(positional.slice(1), "--role");
    if (role === "") {
      return { kind: "error", message: "--role requires a value" };
    }
    return {
      kind: "list",
      json,
      ...(role ? { role } : {}),
      ...(assistantId ? { assistantId } : {}),
    };
  }

  if (subcommand === "get") {
    const contactId = positional[1];
    if (!contactId || contactId.startsWith("-")) {
      return {
        kind: "error",
        message:
          "Missing required argument: <contactId>. Run 'vellum gateway contacts list' to find IDs.",
      };
    }
    return {
      kind: "get",
      contactId,
      json,
      ...(assistantId ? { assistantId } : {}),
    };
  }

  if (subcommand === "set-threshold") {
    const contactId = positional[1];
    if (!contactId || contactId.startsWith("-")) {
      return {
        kind: "error",
        message:
          "Missing required argument: <contactId>. Run 'vellum gateway contacts list' to find IDs.",
      };
    }
    const threshold = readFlag(positional.slice(2), "--threshold");
    if (threshold === undefined) {
      return {
        kind: "error",
        message:
          "Missing required flag: --threshold none|low|medium|high|inherit",
      };
    }
    if (threshold === "" || !isThresholdFlag(threshold)) {
      return {
        kind: "error",
        message:
          `Invalid --threshold "${threshold}". Must be one of: none, low, medium, high, inherit.`,
      };
    }
    return {
      kind: "set-threshold",
      contactId,
      threshold: threshold === "inherit" ? null : threshold,
      json,
      ...(assistantId ? { assistantId } : {}),
    };
  }

  return {
    kind: "error",
    message: `Unknown contacts subcommand: ${subcommand}`,
  };
}

export function gatewayContactsUsage(): string {
  return [
    "Usage: vellum gateway contacts <subcommand>",
    "",
    "Operator commands for gateway-owned contact ACL.",
    "The assistant-access ceiling is stored on the contact as none, low,",
    "medium, or high. inherit clears it so the contact follows room and",
    "trust-class settings.",
    "",
    "Subcommands:",
    "  list                         List contacts",
    "  get <contactId>              Get one contact",
    "  set-threshold <contactId>    Set the assistant-access ceiling",
    "",
    "Options:",
    "  --assistant <id>             Target assistant (defaults to active)",
    "  --role <role>                Filter list by contact or guardian",
    "  --threshold <value>          none, low, medium, high, or inherit",
    "  --json                       Machine-readable JSON",
    "",
    "Examples:",
    "  $ vellum gateway contacts list",
    "  $ vellum gateway contacts get abc-123",
    "  $ vellum gateway contacts set-threshold abc-123 --threshold high",
    "  $ vellum gateway contacts set-threshold abc-123 --threshold inherit",
    "",
    "Inside the gateway container, use `gateway contacts` instead.",
  ].join("\n");
}

interface ContactRecord {
  id: string;
  displayName: string;
  role?: string | null;
  autoApproveThreshold?: string | null;
  channels?: Array<{ id?: string; type?: string; address?: string }>;
}

export async function executeGatewayContactsCommand(
  parsed: ParsedGatewayContactsCommand,
): Promise<number> {
  if (parsed.kind === "help") {
    console.log(gatewayContactsUsage());
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error("");
    console.error(gatewayContactsUsage());
    return 1;
  }

  const entry = resolveTargetAssistant(parsed.assistantId);
  const gatewayUrl = entry.localUrl || entry.runtimeUrl;
  if (!gatewayUrl) {
    console.error("No gateway URL found for this assistant.");
    return 1;
  }

  const token = await resolveAccessToken(gatewayUrl, entry.assistantId);
  if (!token) {
    return 1;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (parsed.kind === "list") {
    const url = new URL(`${gatewayUrl.replace(/\/+$/, "")}/v1/contacts`);
    if (parsed.role) {
      url.searchParams.set("role", parsed.role);
    }
    const response = await loopbackSafeFetch(url.toString(), { headers });
    if (!response.ok) {
      return failHttp(response.status, await readError(response));
    }
    const body = (await response.json()) as { contacts?: ContactRecord[] };
    const contacts = body.contacts ?? [];
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, contacts }));
      return 0;
    }
    if (contacts.length === 0) {
      console.log("No contacts found.");
      return 0;
    }
    for (const contact of contacts) {
      const ceiling = contact.autoApproveThreshold ?? "inherit";
      const role = contact.role ?? "contact";
      console.log(
        `${contact.id}  ${contact.displayName}  ${role}  access:${ceiling}`,
      );
    }
    console.log("");
    console.log(`${contacts.length} contact(s)`);
    return 0;
  }

  if (parsed.kind === "get") {
    const response = await loopbackSafeFetch(
      `${gatewayUrl.replace(/\/+$/, "")}/v1/contacts/${parsed.contactId}`,
      { headers },
    );
    if (response.status === 404) {
      console.error(
        `Contact "${parsed.contactId}" not found. Run 'vellum gateway contacts list' to see IDs.`,
      );
      return 1;
    }
    if (!response.ok) {
      return failHttp(response.status, await readError(response));
    }
    const body = (await response.json()) as { contact?: ContactRecord };
    const contact = body.contact;
    if (!contact) {
      console.error(
        `Contact "${parsed.contactId}" not found. Run 'vellum gateway contacts list' to see IDs.`,
      );
      return 1;
    }
    if (parsed.json) {
      console.log(JSON.stringify({ ok: true, contact }));
      return 0;
    }
    console.log(formatContact(contact));
    return 0;
  }

  const existing = await loopbackSafeFetch(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/contacts/${parsed.contactId}`,
    { headers },
  );
  if (existing.status === 404) {
    console.error(
      `Contact "${parsed.contactId}" not found. Run 'vellum gateway contacts list' to see IDs.`,
    );
    return 1;
  }
  if (!existing.ok) {
    return failHttp(existing.status, await readError(existing));
  }
  const existingBody = (await existing.json()) as { contact?: ContactRecord };
  const displayName = existingBody.contact?.displayName;
  if (!displayName) {
    console.error(
      `Contact "${parsed.contactId}" not found. Run 'vellum gateway contacts list' to see IDs.`,
    );
    return 1;
  }

  const response = await loopbackSafeFetch(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/contacts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: parsed.contactId,
        displayName,
        autoApproveThreshold: parsed.threshold,
      }),
    },
  );
  if (!response.ok) {
    return failHttp(response.status, await readError(response));
  }
  const body = (await response.json()) as { contact?: ContactRecord };
  const ceiling = body.contact?.autoApproveThreshold ?? "inherit";
  if (parsed.json) {
    console.log(
      JSON.stringify({
        ok: true,
        contactId: parsed.contactId,
        threshold: body.contact?.autoApproveThreshold ?? null,
      }),
    );
    return 0;
  }
  console.log(`Set assistant access for ${parsed.contactId} to ${ceiling}`);
  return 0;
}

export async function gatewayContacts(): Promise<void> {
  const parsed = parseGatewayContactsArgs(process.argv.slice(4));
  const code = await executeGatewayContactsCommand(parsed);
  process.exit(code);
}

async function resolveAccessToken(
  gatewayUrl: string,
  assistantId: string,
): Promise<string | null> {
  const tokenData = loadGuardianToken(assistantId);
  if (!tokenData) {
    console.error(
      "No guardian token found for this assistant. Run 'vellum hatch' or 'vellum wake'.",
    );
    return null;
  }
  const expiresAt = new Date(tokenData.accessTokenExpiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 5_000) {
    return tokenData.accessToken;
  }
  const refreshed = await refreshGuardianTokenResult(gatewayUrl, assistantId);
  if (!refreshed.ok) {
    console.error(refreshed.error);
    return null;
  }
  return refreshed.token.accessToken;
}

function failHttp(status: number, message: string): number {
  console.error(`Gateway returned ${status}: ${message}`);
  return status >= 500 ? 3 : 2;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
    };
    if (typeof body.error === "string") {
      return body.error;
    }
    if (body.error?.message) {
      return body.error.message;
    }
  } catch {
    /* use status text */
  }
  return response.statusText || "request failed";
}

function formatContact(contact: ContactRecord): string {
  const lines = [
    `ID:           ${contact.id}`,
    `Display Name: ${contact.displayName}`,
    `Role:         ${contact.role ?? "contact"}`,
    `Access:       ${contact.autoApproveThreshold ?? "inherit"}`,
  ];
  const channels = contact.channels ?? [];
  if (channels.length > 0) {
    lines.push("");
    lines.push("Channels:");
    for (const channel of channels) {
      lines.push(
        `  ${channel.id ?? "?"}  ${channel.type ?? "?"}  ${channel.address ?? "?"}`,
      );
    }
  }
  return lines.join("\n");
}
