import { extractAssistantFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
} from "../lib/assistant-config.js";

type FeatureFlagEntry = {
  key: string;
  label: string;
  enabled: boolean;
  defaultEnabled: boolean;
  description: string;
};

type FlagsResponse = {
  flags: FeatureFlagEntry[];
};

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function printFlagTable(flags: FeatureFlagEntry[]): void {
  const headers = {
    key: "KEY",
    enabled: "ENABLED",
    default: "DEFAULT",
    label: "LABEL",
  };

  const rows = flags
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => ({
      key: f.enabled !== f.defaultEnabled ? `* ${f.key}` : `  ${f.key}`,
      enabled: String(f.enabled),
      default: String(f.defaultEnabled),
      label: f.label,
    }));

  const all = [headers, ...rows];
  const colWidths = {
    key: Math.max(...all.map((r) => r.key.length)),
    enabled: Math.max(...all.map((r) => r.enabled.length)),
    default: Math.max(...all.map((r) => r.default.length)),
    label: Math.max(...all.map((r) => r.label.length)),
  };

  const formatRow = (r: typeof headers) =>
    `${pad(r.key, colWidths.key)}  ${pad(r.enabled, colWidths.enabled)}  ${pad(r.default, colWidths.default)}  ${r.label}`;

  console.log(formatRow(headers));
  console.log(
    `${"-".repeat(colWidths.key)}  ${"-".repeat(colWidths.enabled)}  ${"-".repeat(colWidths.default)}  ${"-".repeat(colWidths.label)}`,
  );
  for (const row of rows) {
    console.log(formatRow(row));
  }
  console.log("");
  console.log("* = overridden (differs from default)");
}

function printHelp(): void {
  console.log("Usage: vellum flags [subcommand] [options]");
  console.log("");
  console.log("Show and toggle feature flags for the active assistant.");
  console.log(
    "Reads from the gateway's merged flag state (persisted overrides > remote > defaults).",
  );
  console.log("");
  console.log("Subcommands:");
  console.log("  (none)              List all feature flags in a table");
  console.log("  get <key>           Show details for a single flag");
  console.log("  set <key> <bool>    Set a flag override to true or false");
  console.log("");
  console.log("Options:");
  console.log(
    "  --assistant <name>  Target a specific assistant (display name or ID)",
  );
  console.log(
    "                      instead of the active one. Useful for scripted",
  );
  console.log(
    "                      flows like eval harnesses that must not mutate",
  );
  console.log("                      the user's active-assistant pointer.");
  console.log("  --help, -h          Show this help");
  console.log("");
  console.log("Examples:");
  console.log(
    "  $ vellum flags                                              # list flags for active assistant",
  );
  console.log(
    "  $ vellum flags get voice-mode                                 # inspect one flag",
  );
  console.log(
    "  $ vellum flags set voice-mode true                           # enable a flag",
  );
  console.log(
    "  $ vellum flags set voice-mode true --assistant eval-1       # target by name/id",
  );
}

function createClient(assistantName?: string): AssistantClient {
  // When `--assistant <name>` is provided, resolve the display name or
  // explicit ID through the standard lookup helper (see cli/AGENTS.md
  // "Assistant targeting convention"). Exact ID wins over display-name
  // matches; ambiguous names fail loudly.
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
      "Could not reach the assistant gateway. Is it running? Try 'vellum wake'.",
    );
  }
  throw err;
}

async function listFlags(assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.get("/feature-flags");
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch flags: HTTP ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as FlagsResponse;
  if (data.flags.length === 0) {
    console.log("No feature flags found.");
    return;
  }
  printFlagTable(data.flags);
}

async function getFlag(key: string, assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.get("/feature-flags");
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to fetch flags: HTTP ${res.status} ${body}`.trim());
  }
  const data = (await res.json()) as FlagsResponse;
  const flag = data.flags.find((f) => f.key === key);
  if (!flag) {
    throw new Error(`Flag "${key}" not found.`);
  }
  console.log(`Key:            ${flag.key}`);
  console.log(`Enabled:        ${flag.enabled}`);
  console.log(`Default:        ${flag.defaultEnabled}`);
  console.log(`Description:    ${flag.description || "(none)"}`);
}

async function setFlag(
  key: string,
  value: boolean,
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.patch(`/feature-flags/${key}`, { enabled: value });
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to set flag: HTTP ${res.status} ${body}`.trim());
  }
  console.log(`Flag "${key}" set to ${value}`);
}

export async function flags(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const assistantName = extractAssistantFlag(args);

  const subcommand = args[0];

  if (!subcommand) {
    await listFlags(assistantName);
    return;
  }

  if (subcommand === "get") {
    const key = args[1];
    if (!key) {
      console.error("Usage: vellum flags get <key>");
      process.exit(1);
    }
    await getFlag(key, assistantName);
    return;
  }

  if (subcommand === "set") {
    const key = args[1];
    const rawValue = args[2];
    if (!key || rawValue === undefined) {
      console.error("Usage: vellum flags set <key> <true|false>");
      process.exit(1);
    }
    if (rawValue !== "true" && rawValue !== "false") {
      console.error(`Invalid value "${rawValue}". Must be "true" or "false".`);
      process.exit(1);
    }
    await setFlag(key, rawValue === "true", assistantName);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  process.exit(1);
}
