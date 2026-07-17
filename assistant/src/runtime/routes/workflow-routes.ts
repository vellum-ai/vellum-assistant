/**
 * Route handlers for workflow-run management.
 *
 * All routes are served by both the HTTP server and the IPC server via the
 * shared ROUTES array. They are read/abort surfaces over the workflow run
 * manager and the saved-workflow library — a human (via the `vellum workflows`
 * CLI or the app) can inspect runs and abort an in-flight one.
 */

import { z } from "zod";

import type { TrustContext } from "../../daemon/trust-context-types.js";
import { buildChannelPermissionCellQuery } from "../../permissions/channel-permission-query.js";
import { getAutoApproveThreshold } from "../../permissions/gateway-threshold-reader.js";
import { isFullAccessThreshold } from "../../permissions/threshold.js";
import { getBindingByConversation } from "../../persistence/external-conversation-store.js";
import { manifestGrantsSideEffects } from "../../workflows/capabilities.js";
import {
  getJournal,
  type WorkflowJournalEntry,
  type WorkflowRun,
} from "../../workflows/journal-store.js";
import { listWorkflows } from "../../workflows/library.js";
import {
  getWorkflowRunManager,
  WorkflowResumeNotPossibleError,
  WorkflowRunCapError,
  type WorkflowRunManager,
} from "../../workflows/run-manager.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Injectable dependencies (production defaults; tests override)
// ---------------------------------------------------------------------------

export interface WorkflowRoutesDeps {
  getManager: () => Pick<
    WorkflowRunManager,
    "list" | "status" | "abort" | "resume"
  >;
  listWorkflows: typeof listWorkflows;
  getAutoApproveThreshold: typeof getAutoApproveThreshold;
  getBindingByConversation: typeof getBindingByConversation;
  getJournal: typeof getJournal;
}

function defaultDeps(): WorkflowRoutesDeps {
  return {
    getManager: getWorkflowRunManager,
    listWorkflows,
    getAutoApproveThreshold,
    getBindingByConversation,
    getJournal,
  };
}

let deps: WorkflowRoutesDeps = defaultDeps();

/** Test seam: override the route dependencies. Pass no arg to restore defaults. */
export function __setWorkflowRoutesDeps(
  overrides?: Partial<WorkflowRoutesDeps>,
): void {
  deps = overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const VALID_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "aborted",
  "cap_exceeded",
  "interrupted",
] as const;

const workflowRunSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  scriptHash: z.string(),
  status: z.enum(VALID_RUN_STATUSES),
  conversationId: z.string().nullable(),
  agentsSpawned: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  error: z.string().nullable(),
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const savedWorkflowSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workflowLeafSchema = z.object({
  seq: z.number(),
  kind: z.enum(["agent", "workflow"]),
  label: z.string().optional(),
  phase: z.string().optional(),
  promptSummary: z.string().optional(),
  status: z.string(),
  resultSummary: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  createdAt: z.number().nullable(),
});

const workflowJournalSchema = z.object({
  runId: z.string(),
  status: z.enum(VALID_RUN_STATUSES).optional(),
  agentsSpawned: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  phase: z.string().optional(),
  leaves: z.array(workflowLeafSchema),
});

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * The single compact-run wire contract, inferred from {@link workflowRunSchema}.
 * The HTTP routes return this shape; other producers (e.g. the CLI's client-side
 * mirror) should track it so projections can't silently drift.
 */
export type WorkflowRunWire = z.infer<typeof workflowRunSchema>;

/** Project a stored run into the wire shape (drops bulky source/args/result). */
export function toWireRun(run: WorkflowRun): WorkflowRunWire {
  return {
    id: run.id,
    name: run.name,
    scriptHash: run.scriptHash,
    status: run.status,
    conversationId: run.conversationId,
    agentsSpawned: run.agentsSpawned,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

/**
 * Render an arbitrary journal value (prompt, result, `{ error }`) into a short
 * single-string preview, truncating to `max` characters. Objects are
 * JSON-stringified so a structured result still produces a readable summary.
 */
function summarize(value: unknown, max = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Project a journal entry into the bounded leaf wire shape, dropping the bulky
 * raw `request`/`result` payloads in favor of short summaries. The `request`
 * and `result` columns are `unknown`, so read their fields defensively.
 */
export function toWireLeaf(
  entry: WorkflowJournalEntry,
): z.infer<typeof workflowLeafSchema> {
  const request =
    entry.request && typeof entry.request === "object"
      ? (entry.request as Record<string, unknown>)
      : undefined;
  const opts =
    request?.opts && typeof request.opts === "object"
      ? (request.opts as Record<string, unknown>)
      : undefined;
  const label = typeof opts?.label === "string" ? opts.label : undefined;
  const phase = typeof opts?.phase === "string" ? opts.phase : undefined;
  const promptSummary = summarize(request?.prompt);
  const resultSummary = summarize(entry.result);
  return {
    seq: entry.seq,
    kind: entry.kind,
    ...(label !== undefined ? { label } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(promptSummary !== undefined ? { promptSummary } : {}),
    status: entry.status,
    ...(resultSummary !== undefined ? { resultSummary } : {}),
    ...(entry.inputTokens !== undefined
      ? { inputTokens: entry.inputTokens }
      : {}),
    ...(entry.outputTokens !== undefined
      ? { outputTokens: entry.outputTokens }
      : {}),
    createdAt: entry.createdAt,
  };
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

function parseStatus(
  raw: string | undefined,
): WorkflowRun["status"] | undefined {
  if (raw === undefined) return undefined;
  return (VALID_RUN_STATUSES as readonly string[]).includes(raw)
    ? (raw as WorkflowRun["status"])
    : undefined;
}

function handleListRuns(queryParams: Record<string, string>) {
  const limit = parseLimit(queryParams.limit);
  const status = parseStatus(queryParams.status);
  const runs = deps.getManager().list({
    ...(limit !== undefined ? { limit } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  return { runs: runs.map(toWireRun) };
}

function handleGetRun(id: string) {
  const run = deps.getManager().status(id);
  if (!run) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  return toWireRun(run);
}

function handleGetRunJournal(id: string) {
  const run = deps.getManager().status(id);
  if (!run) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  return {
    runId: run.id,
    status: run.status,
    agentsSpawned: run.agentsSpawned,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    // Only agent leaves; the live `workflow_leaf_*` stream is emitted solely for
    // agent leaves (nested workflow resolutions never reach it), so the
    // backfilled set must match. `kind: "workflow"` entries carry no label and
    // would render as phantom unlabeled nodes.
    leaves: deps
      .getJournal(id)
      .filter((entry) => entry.kind === "agent")
      .map(toWireLeaf),
  };
}

function handleAbortRun(id: string) {
  // status() is the source of truth for existence; abort() itself is a no-op
  // for unknown/finished runs, so 404 on an unknown id is surfaced here.
  const manager = deps.getManager();
  if (!manager.status(id)) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  manager.abort(id);
  return { ok: true, runId: id };
}

/**
 * Channel-permission cell coordinates for the resume consent gate, derived
 * from the run's persisted originating trust snapshot — the same snapshot
 * `resume()` replays — so the cell that governs the run's tool calls also
 * governs the no-prompt resume. Without this, a strict channel cell would be
 * skipped and the gate would decide off a possibly-looser global threshold.
 *
 * Runs without channel coordinates (desktop/internal origins, legacy rows
 * with no snapshot) yield no query: the cascade then resolves conversation
 * override → global, and the full-access gate is the sole consent check.
 */
function buildResumeCellQuery(
  run: WorkflowRun,
): ReturnType<typeof buildChannelPermissionCellQuery> {
  if (!run.trust || typeof run.trust !== "object") {
    return undefined;
  }
  const snapshot = run.trust as Partial<TrustContext>;
  return buildChannelPermissionCellQuery({
    sourceChannel: snapshot.sourceChannel,
    trustClass: snapshot.trustClass,
    channelConversationType: snapshot.conversationType,
    // Channel-scoped cells key on the binding's external chat id — the
    // canonical conversation address for every channel adapter, and the
    // same lookup conversation-tool-setup uses for live tool calls.
    channelExternalId:
      snapshot.sourceChannel && run.conversationId
        ? deps.getBindingByConversation(run.conversationId)?.externalChatId
        : undefined,
  });
}

async function handleResumeRun(id: string) {
  const manager = deps.getManager();
  // status() is the source of truth for existence, so 404 an unknown id here
  // (matching abort) rather than letting resume's "not_found" reach the client
  // as a 409.
  const run = manager.status(id);
  if (!run) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  // Consent gate. Resuming restarts the run's unfinished leaves, which execute
  // the side-effecting tools/host functions the original manifest granted. The
  // conversational `manage_workflows` resume path promotes such resumes to a
  // fresh interactive approval (executor.ts → requireFreshApproval); this
  // HTTP/IPC route (and the `vellum workflows resume` CLI on top of it) has no
  // prompt channel. At full-access posture the user has opted into
  // auto-approving even high-risk tools, so the resume proceeds without a
  // prompt; otherwise it must not silently bypass consent — refuse and direct
  // the caller to the assistant. A read-only run (no declared tools/host
  // functions) resumes freely regardless of posture.
  if (manifestGrantsSideEffects(run.capabilities)) {
    // The cell query makes the gate honor a strict channel-permission cell
    // for channel-originated runs; without it the read would skip the cell
    // tier and a full-access global would clear the gate the cell blocks.
    const threshold = await deps.getAutoApproveThreshold(
      run.conversationId ?? undefined,
      "conversation",
      buildResumeCellQuery(run),
    );
    if (!isFullAccessThreshold(threshold)) {
      throw new ForbiddenError(
        `Workflow run ${id} was granted side-effecting capabilities; resuming it ` +
          `can restart steps that perform those side effects. Resume it through ` +
          `the assistant (which will ask for approval) instead of this route.`,
      );
    }
  }
  try {
    const { runId } = manager.resume(id);
    return { ok: true, runId };
  } catch (err) {
    if (err instanceof WorkflowResumeNotPossibleError) {
      if (err.reason === "not_found") {
        throw new NotFoundError(`Workflow run ${id} not found`);
      }
      // not_interrupted / in_flight — the run exists but isn't resumable now.
      throw new ConflictError(err.message);
    }
    if (err instanceof WorkflowRunCapError) {
      throw new TooManyRequestsError(err.message);
    }
    throw err;
  }
}

function handleListSavedWorkflows() {
  return { workflows: deps.listWorkflows() };
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listWorkflowRuns",
    endpoint: "workflows/runs",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List workflow runs",
    description: "Return recent workflow runs, newest first.",
    tags: ["workflows"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max runs to return (default 50, max 200)",
      },
      {
        name: "status",
        schema: { type: "string" },
        description:
          "Filter by run status (running, completed, failed, aborted, cap_exceeded, interrupted).",
      },
    ],
    responseBody: z.object({
      runs: z.array(workflowRunSchema).describe("Workflow run objects"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListRuns(queryParams ?? {}),
  },
  {
    operationId: "getWorkflowRun",
    endpoint: "workflows/runs/:id",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get workflow run",
    description: "Return a single workflow run by ID.",
    tags: ["workflows"],
    responseBody: workflowRunSchema,
    additionalResponses: { "404": { description: "Run not found" } },
    handler: ({ pathParams }: RouteHandlerArgs) => handleGetRun(pathParams!.id),
  },
  {
    operationId: "getWorkflowRunJournal",
    endpoint: "workflows/runs/:id/journal",
    method: "GET",
    // Unlike the run list/status routes (settings metadata), the journal returns
    // per-leaf prompt/result summaries — conversation/work-product content — so it
    // requires `chat.read`, matching the subagent-detail route (the analogous
    // content surface), not the `settings.read` used by the management routes.
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get workflow run journal",
    description:
      "Return a workflow run's leaf journal as bounded per-leaf summaries (one entry per finished leaf).",
    tags: ["workflows"],
    responseBody: workflowJournalSchema,
    additionalResponses: { "404": { description: "Run not found" } },
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleGetRunJournal(pathParams!.id),
  },
  {
    operationId: "abortWorkflowRun",
    endpoint: "workflows/runs/:id/abort",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Abort workflow run",
    description: "Signal an in-flight workflow run to abort.",
    tags: ["workflows"],
    responseBody: z.object({
      ok: z.boolean(),
      runId: z.string(),
    }),
    additionalResponses: { "404": { description: "Run not found" } },
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleAbortRun(pathParams!.id),
  },
  {
    operationId: "resumeWorkflowRun",
    endpoint: "workflows/runs/:id/resume",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Resume workflow run",
    description:
      "Resume an interrupted workflow run (one orphaned by an assistant restart), replaying its journaled prefix and continuing from the first unfinished step.",
    tags: ["workflows"],
    responseBody: z.object({
      ok: z.boolean(),
      runId: z.string(),
    }),
    additionalResponses: {
      "404": { description: "Run not found" },
      "409": { description: "Run is not resumable (not interrupted)" },
      "429": { description: "Concurrent-run cap reached" },
    },
    handler: ({ pathParams }: RouteHandlerArgs) =>
      handleResumeRun(pathParams!.id),
  },
  {
    operationId: "listSavedWorkflows",
    endpoint: "workflows",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List saved workflows",
    description: "Return the saved (named) workflows the assistant can run.",
    tags: ["workflows"],
    responseBody: z.object({
      workflows: z
        .array(savedWorkflowSchema)
        .describe("Saved workflow entries"),
    }),
    handler: () => handleListSavedWorkflows(),
  },
];
