/**
 * Route handlers for workflow-run management.
 *
 * All routes are served by both the HTTP server and the IPC server via the
 * shared ROUTES array. They are read/abort surfaces over the workflow run
 * manager and the saved-workflow library — a human (via the `vellum workflows`
 * CLI or the app) can inspect runs and abort an in-flight one.
 *
 * Every handler is gated on the `workflows` feature flag: when it is off, the
 * routes behave as if they do not exist (404), so disabling the flag fully
 * hides the surface.
 */

import { z } from "zod";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import { manifestGrantsSideEffects } from "../../workflows/capabilities.js";
import type { WorkflowRun } from "../../workflows/journal-store.js";
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
  getConfig: () => AssistantConfig;
  isFlagEnabled: (config: AssistantConfig) => boolean;
}

function defaultDeps(): WorkflowRoutesDeps {
  return {
    getManager: getWorkflowRunManager,
    listWorkflows,
    getConfig,
    isFlagEnabled: (config) =>
      isAssistantFeatureFlagEnabled("workflows", config),
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

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

/**
 * Throw a 404 when the `workflows` flag is off, hiding the whole surface. The
 * NotFoundError (rather than a 403) keeps a disabled-flag indistinguishable
 * from a route that does not exist.
 */
function assertFlagEnabled(): void {
  if (!deps.isFlagEnabled(deps.getConfig())) {
    throw new NotFoundError("Workflows are not enabled.");
  }
}

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
  assertFlagEnabled();
  const limit = parseLimit(queryParams.limit);
  const status = parseStatus(queryParams.status);
  const runs = deps.getManager().list({
    ...(limit !== undefined ? { limit } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  return { runs: runs.map(toWireRun) };
}

function handleGetRun(id: string) {
  assertFlagEnabled();
  const run = deps.getManager().status(id);
  if (!run) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  return toWireRun(run);
}

function handleAbortRun(id: string) {
  assertFlagEnabled();
  // status() is the source of truth for existence; abort() itself is a no-op
  // for unknown/finished runs, so 404 on an unknown id is surfaced here.
  const manager = deps.getManager();
  if (!manager.status(id)) {
    throw new NotFoundError(`Workflow run ${id} not found`);
  }
  manager.abort(id);
  return { ok: true, runId: id };
}

function handleResumeRun(id: string) {
  assertFlagEnabled();
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
  // prompt channel, so it must not silently bypass that consent point. Refuse a
  // side-effecting resume and direct the caller to the assistant; a read-only
  // run (no declared tools/host functions) resumes freely.
  if (manifestGrantsSideEffects(run.capabilities)) {
    throw new ForbiddenError(
      `Workflow run ${id} was granted side-effecting capabilities; resuming it ` +
        `can restart steps that perform those side effects. Resume it through ` +
        `the assistant (which will ask for approval) instead of this route.`,
    );
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
  assertFlagEnabled();
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
