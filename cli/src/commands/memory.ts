import { extractAssistantFlag, extractValueFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
} from "../lib/assistant-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemoryNode = {
  id: string;
  content: string;
  type: string;
  fidelity: string;
  created: number;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
      "Could not reach the assistant gateway. Is it running? Try 'vellum wake'.",
    );
  }
  throw err;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${month} ${day}, ${displayHour}:${minutes} ${ampm}`;
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("Usage: vellum memory <subcommand> [options]");
  console.log("");
  console.log(
    "Manage the assistant's long-term memory graph (requires memory v2).",
  );
  console.log("");
  console.log("Subcommands:");
  console.log("  list              List active memory nodes");
  console.log("  delete <content>  Delete a memory node by content match");
  console.log("  update <old> <new>  Update a memory node in place");
  console.log("");
  console.log("Options:");
  console.log(
    "  --assistant <name>  Target a specific assistant (display name or ID)",
  );
  console.log("  --help, -h          Show this help");
  console.log("");
  console.log("List options:");
  console.log(
    "  --search <query>    Filter nodes whose content contains <query>",
  );
  console.log("  --limit <n>         Max results (default 50, max 200)");
  console.log("");
  console.log("Examples:");
  console.log("  $ vellum memory list");
  console.log("  $ vellum memory list --search TypeScript");
  console.log("  $ vellum memory list --limit 100");
  console.log('  $ vellum memory delete "User prefers TypeScript"');
  console.log('  $ vellum memory update "old fact" "corrected fact"');
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function printNodeTable(nodes: MemoryNode[]): void {
  const CONTENT_WIDTH = 60;
  const headers = {
    content: "CONTENT",
    type: "TYPE",
    fidelity: "FIDELITY",
    created: "CREATED",
  };

  const rows = nodes.map((n) => ({
    content:
      n.content.length > CONTENT_WIDTH
        ? n.content.slice(0, CONTENT_WIDTH - 1) + "…"
        : n.content,
    type: n.type,
    fidelity: n.fidelity,
    created: formatTimestamp(n.created),
  }));

  const all = [headers, ...rows];
  const colWidths = {
    content: Math.max(...all.map((r) => r.content.length)),
    type: Math.max(...all.map((r) => r.type.length)),
    fidelity: Math.max(...all.map((r) => r.fidelity.length)),
    created: Math.max(...all.map((r) => r.created.length)),
  };

  const formatRow = (r: (typeof all)[number]) =>
    `${pad(r.content, colWidths.content)}  ${pad(r.type, colWidths.type)}  ${pad(r.fidelity, colWidths.fidelity)}  ${r.created}`;

  console.log(formatRow(headers));
  console.log(
    `${"-".repeat(colWidths.content)}  ${"-".repeat(colWidths.type)}  ${"-".repeat(colWidths.fidelity)}  ${"-".repeat(colWidths.created)}`,
  );
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

async function memoryList(
  search: string | undefined,
  limit: number,
  assistantName: string | undefined,
): Promise<void> {
  const client = createClient(assistantName);

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));

  let res: Response;
  try {
    res = await client.get(`/memory/list?${params.toString()}`);
  } catch (err) {
    rethrowFetchError(err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to list memories: HTTP ${res.status} ${body}`.trim(),
    );
  }

  const data = (await res.json()) as { nodes: MemoryNode[]; total: number };

  if (data.nodes.length === 0) {
    console.log(
      search
        ? `No memories found matching "${search}".`
        : "No memories found. The memory graph is empty.",
    );
    return;
  }

  printNodeTable(data.nodes);
  console.log("");
  console.log(
    `${data.total} memor${data.total === 1 ? "y" : "ies"}${search ? ` matching "${search}"` : ""}.`,
  );
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function memoryDelete(
  content: string,
  assistantName: string | undefined,
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

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function memoryUpdate(
  oldContent: string,
  newContent: string,
  assistantName: string | undefined,
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function memory(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const assistantName = extractAssistantFlag(args);
  const sub = args[0];

  // ── list ──────────────────────────────────────────────────────────────────
  if (sub === "list") {
    const search = extractValueFlag(args, "search");
    const limitStr = extractValueFlag(args, "limit");
    const limit = limitStr ? Math.max(1, Math.min(200, Number(limitStr))) : 50;
    if (limitStr && !Number.isFinite(limit)) {
      console.error(`Invalid --limit value: "${limitStr}"`);
      process.exit(1);
    }
    await memoryList(search, limit, assistantName);
    return;
  }

  // ── delete ─────────────────────────────────────────────────────────────────
  if (sub === "delete") {
    const content = args[1];
    if (!content) {
      console.error('Usage: vellum memory delete "<content>"');
      process.exit(1);
    }
    await memoryDelete(content, assistantName);
    return;
  }

  // ── update ─────────────────────────────────────────────────────────────────
  if (sub === "update") {
    const oldContent = args[1];
    const newContent = args[2];
    if (!oldContent || !newContent) {
      console.error(
        'Usage: vellum memory update "<old content>" "<new content>"',
      );
      process.exit(1);
    }
    await memoryUpdate(oldContent, newContent, assistantName);
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  printHelp();
  process.exit(1);
}
