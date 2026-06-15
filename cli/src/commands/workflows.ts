import { extractAssistantFlag, extractValueFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
} from "../lib/assistant-config.js";

/**
 * Client-side mirror of the server's wire-run projection
 * (`WorkflowRunWire` from `assistant/src/runtime/routes/workflow-routes.ts`).
 * The CLI is an independent build unit and deliberately does NOT import from
 * `assistant/` (see `cli/src/shared/provider-env-vars.ts`), so the shape is
 * mirrored here. Only the fields the CLI renders are declared — the server may
 * send a superset. Keep in sync with `workflowRunSchema`.
 */
type WorkflowRun = {
  id: string;
  name: string | null;
  status: string;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: number | null;
  finishedAt: number | null;
};

type SavedWorkflow = {
  name: string;
  description: string;
  path: string;
};

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function fmtTime(ms: number | null): string {
  return ms == null ? "-" : new Date(ms).toISOString();
}

function printRunsTable(runs: WorkflowRun[]): void {
  const headers = {
    id: "ID",
    name: "NAME",
    status: "STATUS",
    agents: "AGENTS",
    created: "CREATED",
  };
  const rows = runs.map((r) => ({
    id: r.id,
    name: r.name ?? "-",
    status: r.status,
    agents: String(r.agentsSpawned),
    created: fmtTime(r.createdAt),
  }));
  const all = [headers, ...rows];
  const w = {
    id: Math.max(...all.map((r) => r.id.length)),
    name: Math.max(...all.map((r) => r.name.length)),
    status: Math.max(...all.map((r) => r.status.length)),
    agents: Math.max(...all.map((r) => r.agents.length)),
    created: Math.max(...all.map((r) => r.created.length)),
  };
  const formatRow = (r: typeof headers) =>
    `${pad(r.id, w.id)}  ${pad(r.name, w.name)}  ${pad(r.status, w.status)}  ${pad(r.agents, w.agents)}  ${r.created}`;
  console.log(formatRow(headers));
  console.log(
    `${"-".repeat(w.id)}  ${"-".repeat(w.name)}  ${"-".repeat(w.status)}  ${"-".repeat(w.agents)}  ${"-".repeat(w.created)}`,
  );
  for (const row of rows) console.log(formatRow(row));
}

function printSavedTable(workflows: SavedWorkflow[]): void {
  const headers = { name: "NAME", description: "DESCRIPTION" };
  const rows = workflows.map((w) => ({
    name: w.name,
    description: w.description,
  }));
  const all = [headers, ...rows];
  const w = {
    name: Math.max(...all.map((r) => r.name.length)),
    description: Math.max(...all.map((r) => r.description.length)),
  };
  const formatRow = (r: typeof headers) =>
    `${pad(r.name, w.name)}  ${r.description}`;
  console.log(formatRow(headers));
  console.log(`${"-".repeat(w.name)}  ${"-".repeat(w.description)}`);
  for (const row of rows) console.log(formatRow(row));
}

function printHelp(): void {
  console.log("Usage: vellum workflows <subcommand> [options]");
  console.log("");
  console.log("Inspect and control workflow runs on the active assistant.");
  console.log("");
  console.log("Subcommands:");
  console.log("  list              List saved (named) workflows");
  console.log("  runs              List recent workflow runs");
  console.log("  show <run-id>     Show details for a single run");
  console.log("  abort <run-id>    Abort an in-flight run");
  console.log(
    "  resume <run-id>   Resume an interrupted run (orphaned by a restart)",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --assistant <name>  Target a specific assistant (display name or ID)",
  );
  console.log("  --limit <n>         (runs) Max runs to list");
  console.log("  --status <status>   (runs) Filter by run status");
  console.log("  --help, -h          Show this help");
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

async function requestJson<T>(
  client: AssistantClient,
  method: "get" | "post",
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res =
      method === "get"
        ? await client.get(path, query ? { query } : undefined)
        : await client.post(path, undefined);
  } catch (err) {
    rethrowFetchError(err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Request failed: HTTP ${res.status} ${body}`.trim());
  }
  return (await res.json()) as T;
}

async function listSaved(assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  const data = await requestJson<{ workflows: SavedWorkflow[] }>(
    client,
    "get",
    "/workflows",
  );
  if (data.workflows.length === 0) {
    console.log("No saved workflows found.");
    return;
  }
  printSavedTable(data.workflows);
}

async function listRuns(
  opts: { limit?: string; status?: string },
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  const query: Record<string, string> = {};
  if (opts.limit) query.limit = opts.limit;
  if (opts.status) query.status = opts.status;
  const data = await requestJson<{ runs: WorkflowRun[] }>(
    client,
    "get",
    "/workflows/runs",
    Object.keys(query).length ? query : undefined,
  );
  if (data.runs.length === 0) {
    console.log("No workflow runs found.");
    return;
  }
  printRunsTable(data.runs);
}

async function showRun(runId: string, assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  const run = await requestJson<WorkflowRun>(
    client,
    "get",
    `/workflows/runs/${runId}`,
  );
  console.log(`ID:             ${run.id}`);
  console.log(`Name:           ${run.name ?? "(unnamed)"}`);
  console.log(`Status:         ${run.status}`);
  console.log(`Agents spawned: ${run.agentsSpawned}`);
  console.log(
    `Tokens:         ${run.inputTokens} in / ${run.outputTokens} out`,
  );
  console.log(`Created:        ${fmtTime(run.createdAt)}`);
  console.log(`Finished:       ${fmtTime(run.finishedAt)}`);
  if (run.error) console.log(`Error:          ${run.error}`);
}

async function abortRun(runId: string, assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  await requestJson<{ ok: boolean; runId: string }>(
    client,
    "post",
    `/workflows/runs/${runId}/abort`,
  );
  console.log(`Abort signalled for workflow run ${runId}.`);
}

async function resumeRun(runId: string, assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  await requestJson<{ ok: boolean; runId: string }>(
    client,
    "post",
    `/workflows/runs/${runId}/resume`,
  );
  console.log(
    `Resumed workflow run ${runId}. It replays its completed steps and continues from where it was interrupted.`,
  );
}

export async function workflows(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const assistantName = extractAssistantFlag(args);
  const limit = extractValueFlag(args, "limit");
  const status = extractValueFlag(args, "status");
  const subcommand = args[0];

  if (!subcommand || subcommand === "list") {
    await listSaved(assistantName);
    return;
  }

  if (subcommand === "runs") {
    await listRuns({ limit, status }, assistantName);
    return;
  }

  if (subcommand === "show") {
    const runId = args[1];
    if (!runId) {
      console.error("Usage: vellum workflows show <run-id>");
      process.exit(1);
    }
    await showRun(runId, assistantName);
    return;
  }

  if (subcommand === "abort") {
    const runId = args[1];
    if (!runId) {
      console.error("Usage: vellum workflows abort <run-id>");
      process.exit(1);
    }
    await abortRun(runId, assistantName);
    return;
  }

  if (subcommand === "resume") {
    const runId = args[1];
    if (!runId) {
      console.error("Usage: vellum workflows resume <run-id>");
      process.exit(1);
    }
    await resumeRun(runId, assistantName);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  process.exit(1);
}
