/**
 * Route handlers for ACP (Agent Communication Protocol) session lifecycle.
 *
 * Exposes spawn, steer, cancel, close, sessions, and permission operations
 * over HTTP and IPC.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getAcpSessionManager } from "../../acp/index.js";
import {
  LINKABLE_ACP_FIELDS,
  LINKABLE_FIELD_DESCRIPTIONS,
  type LinkableAcpField,
} from "../../acp/credential-fields.js";
import {
  ACP_SPAWN_TOOL,
  prepareAgentEnv,
} from "../../acp/prepare-agent-env.js";
import { resolveAcpAgent } from "../../acp/resolve-agent.js";
import type { AcpSessionState } from "../../acp/types.js";
import { resolveAcpWorkspaceDir } from "../../acp/workspace-path.js";
import { getDb } from "../../memory/db-connection.js";
import { rawChanges } from "../../memory/raw-query.js";
import { acpSessionHistory } from "../../memory/schema.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  getActiveBackendName,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import {
  assertMetadataWritable,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  FailedDependencyError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const TERMINAL_SESSION_STATUSES = ["completed", "failed", "cancelled"] as const;

const log = getLogger("acp-routes");

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;

/** Service namespace under which all linked ACP credentials are stored. */
const ACP_CREDENTIAL_SERVICE = "acp";

const sessionEntrySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  acpSessionId: z.string(),
  parentConversationId: z.string().optional(),
  status: z.string(),
  startedAt: z.number(),
  completedAt: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  stopReason: z.string().nullable().optional(),
  eventLog: z.array(z.unknown()).optional(),
});

type SessionEntry = z.infer<typeof sessionEntrySchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function spawnSession({ body }: RouteHandlerArgs) {
  const agent = body?.agent as string | undefined;
  const task = body?.task as string | undefined;
  const conversationId = body?.conversationId as string | undefined;

  if (!agent || !task || !conversationId) {
    throw new BadRequestError("agent, task, and conversationId are required");
  }

  // Default to a STABLE per-project directory under the persistent workspace
  // volume (keyed by conversation id) so the agent's clones and edits survive
  // across turns, respawns, and idle-sleep — not an ephemeral `process.cwd()`.
  // An explicit `cwd` (e.g. a git worktree for isolated work) still wins.
  const cwd =
    (body?.cwd as string | undefined) ?? resolveAcpWorkspaceDir(conversationId);

  const resolved = resolveAcpAgent(agent);
  if (!resolved.ok) {
    switch (resolved.reason) {
      case "acp_disabled":
        throw new BadRequestError(resolved.hint);
      case "unknown_agent":
        throw new BadRequestError(
          `Unknown agent "${agent}". Available: ${resolved.available.join(", ")}.`,
        );
      case "binary_not_found":
        throw new FailedDependencyError(
          `${resolved.command} is not on PATH. ${resolved.hint}`,
        );
      default: {
        const _exhaustive: never = resolved;
        throw new Error(
          `Unexpected acp resolver reason: ${(_exhaustive as { reason: string }).reason}`,
        );
      }
    }
  }

  // Inject required env vars and preflight via the shared helper. See
  // `acp/prepare-agent-env.ts` for the full rationale; calling it here
  // keeps the HTTP route in lockstep with the skill-tool spawn path
  // (`tools/acp/spawn.ts`).
  const agentConfig = await prepareAgentEnv(resolved.agent);

  log.info(
    { agent, task: task.slice(0, 100), conversationId },
    "ACP spawn request received",
  );

  const manager = getAcpSessionManager();
  const { acpSessionId, protocolSessionId } = await manager.spawn(
    agent,
    agentConfig,
    task,
    cwd,
    conversationId,
    broadcastMessage,
  );

  log.info({ acpSessionId, protocolSessionId, agent }, "ACP spawn succeeded");
  return { acpSessionId, protocolSessionId, agent };
}

/**
 * Link a per-user ACP/dev credential into the pod's secure store.
 *
 * Hosted users have no shell, so they cannot run `assistant credentials set`.
 * This route is the client → gateway → daemon path that writes the BYO
 * secret into the SAME broker location `prepare-agent-env.ts` reads:
 * `credential/acp/<field>` in secure-keys, with metadata whose
 * `allowedTools` is `["acp_spawn"]` so only the agent spawn path can read it.
 *
 * Invariants (enforced here, asserted by tests):
 *  - WRITE-ONLY over the wire: the response NEVER echoes the value back.
 *  - IN-POD ONLY: the value goes to the local secure store; it is never sent
 *    centrally (no managed-catalog / platform sync call on this path).
 *  - Locked to the {@link LINKABLE_ACP_FIELDS} allowlist.
 */
async function linkCredential({ body }: RouteHandlerArgs) {
  const rawField = body?.field;
  const value = body?.value as string | undefined;

  if (!rawField || typeof rawField !== "string") {
    throw new BadRequestError("field is required");
  }
  if (!LINKABLE_ACP_FIELDS.includes(rawField as LinkableAcpField)) {
    throw new BadRequestError(
      `field must be one of: ${LINKABLE_ACP_FIELDS.join(", ")}`,
    );
  }
  const field = rawField as LinkableAcpField;
  if (!value || typeof value !== "string") {
    throw new BadRequestError("value is required");
  }

  // Fail before any side effects if the metadata store is on an
  // unrecognized version, mirroring `credentials/set`.
  assertMetadataWritable();

  const storageKey = credentialKey(ACP_CREDENTIAL_SERVICE, field);
  const stored = await setSecureKeyAsync(storageKey, value);
  if (!stored) {
    throw new InternalError(
      `Failed to store ACP credential in secure storage (backend: ${getActiveBackendName()})`,
    );
  }

  // Scope the credential to acp_spawn ONLY so nothing but the agent spawn
  // path can read it back through the broker. We always (re)assert this
  // policy on link so the client can never widen it.
  upsertCredentialMetadata(ACP_CREDENTIAL_SERVICE, field, {
    allowedTools: [ACP_SPAWN_TOOL],
    usageDescription: LINKABLE_FIELD_DESCRIPTIONS[field],
  });

  log.info({ field }, "ACP credential linked");

  // Write-only: respond with the field name and a boolean ONLY. Never the
  // value, never a scrubbed preview that could leak length/suffix.
  return { field, linked: true };
}

async function steerSession({ pathParams, body }: RouteHandlerArgs) {
  const id = pathParams?.id as string;
  const instruction = body?.instruction as string | undefined;

  if (!instruction) {
    throw new BadRequestError("instruction is required");
  }

  const manager = getAcpSessionManager();
  try {
    await manager.steer(id, instruction);
  } catch {
    throw new NotFoundError("ACP session not found");
  }
  return { acpSessionId: id, steered: true };
}

/**
 * Send a follow-up turn to an existing LIVE (running/idle) ACP session so the
 * agent builds on the same context and workspace.
 *
 * Distinct from `spawnSession` (fresh process/session) and `steerSession`
 * (the HTTP verb is the same `manager.steer`, but `acp_continue` targets a
 * session left `idle` after its previous task completed — the multi-turn
 * continuity path). The target session is resolved from an explicit
 * `acpSessionId` when provided, otherwise from the conversation's most-recent
 * live session via `getLiveSessionForConversation`. A closed / non-existent
 * session errors cleanly with a 404 RouteError — never a crash.
 *
 * A session whose prompt is still in flight (`running`/`initializing`) is
 * rejected with a 409 ConflictError rather than steered: `manager.steer`'s
 * running-session path CANCELS the in-flight prompt, so continuing a busy
 * session would abort the in-progress task. Only an idle (or otherwise
 * non-running live) session is continued.
 */
async function continueSession({ body }: RouteHandlerArgs) {
  const instruction = body?.instruction as string | undefined;
  const explicitId = body?.acpSessionId as string | undefined;
  const conversationId = body?.conversationId as string | undefined;

  if (!instruction) {
    throw new BadRequestError("instruction is required");
  }
  if (!explicitId && !conversationId) {
    throw new BadRequestError("acpSessionId or conversationId is required");
  }

  const manager = getAcpSessionManager();

  let acpSessionId = explicitId;
  // The resolved target's live status. For the conversation path
  // `getLiveSessionForConversation` already carries it; for an explicit id we
  // read it via `getStatus` (which throws for unknown ids — that maps to 404).
  let status: AcpSessionState["status"] | undefined;
  if (acpSessionId) {
    try {
      const state = manager.getStatus(acpSessionId);
      if (!Array.isArray(state)) status = state.status;
    } catch {
      throw new NotFoundError("ACP session not found or not reusable");
    }
  } else {
    const live = manager.getLiveSessionForConversation(conversationId!);
    if (!live) {
      throw new NotFoundError(
        "No live ACP session to continue for this conversation",
      );
    }
    acpSessionId = live.id;
    status = live.status;
  }

  // Never steer a session with a prompt in flight: `manager.steer`'s
  // running-session path CANCELS the in-flight prompt, so a follow-up like
  // "also do X" would abort in-progress work. Reject cleanly and let the
  // caller wait for the current task to finish (or cancel it deliberately).
  if (status === "running" || status === "initializing") {
    throw new ConflictError(
      `ACP session "${acpSessionId}" is busy (${status}); wait for the current task to finish before continuing.`,
    );
  }

  try {
    await manager.steer(acpSessionId, instruction);
  } catch {
    throw new NotFoundError("ACP session not found or not reusable");
  }
  return { acpSessionId, continued: true };
}

async function cancelSession({ pathParams }: RouteHandlerArgs) {
  const id = pathParams?.id as string;
  const manager = getAcpSessionManager();
  try {
    await manager.cancel(id);
  } catch {
    throw new NotFoundError("ACP session not found");
  }
  return { acpSessionId: id, cancelled: true };
}

function closeSession({ pathParams }: RouteHandlerArgs) {
  const id = pathParams?.id as string;
  const manager = getAcpSessionManager();
  try {
    manager.close(id);
  } catch {
    throw new NotFoundError("ACP session not found");
  }
  return { acpSessionId: id, closed: true };
}

function listSessions({ queryParams }: RouteHandlerArgs) {
  const limit = parseLimit(queryParams?.limit);
  const conversationId = queryParams?.conversationId;
  const sessions = listMergedSessions({ limit, conversationId });
  return { sessions };
}

function bulkDeleteSessions({ queryParams }: RouteHandlerArgs) {
  const status = queryParams?.status;
  if (status !== "completed") {
    throw new BadRequestError(
      "status query param is required and must be 'completed'",
    );
  }

  // Close any in-memory `idle` session before clearing its persisted row.
  // An idle session is terminal-for-affordances on the client (its last task
  // already wrote a `completed` row), but its adapter process, idle timer, and
  // map entry are still live. Without closing it here the bulk-clear would wipe
  // the DB row only for the session to reappear on the next `/acp/sessions`
  // refresh (the merge re-surfaces the live idle entry) until the idle timeout.
  // `close()` reuses the cycle-1 idle teardown: it skips re-persisting the
  // already-written `completed` row, so the subsequent DB delete still removes
  // it. Active (running/initializing) sessions are left untouched — their rows
  // aren't terminal, so the bulk delete skips them too.
  const manager = getAcpSessionManager();
  const states = manager.getStatus() as AcpSessionState[];
  for (const state of states) {
    if (state.status === "idle") {
      try {
        manager.close(state.id);
      } catch (err) {
        log.warn(
          { acpSessionId: state.id, err },
          "Failed to close idle ACP session during bulk-clear",
        );
      }
    }
  }

  getDb()
    .delete(acpSessionHistory)
    .where(inArray(acpSessionHistory.status, TERMINAL_SESSION_STATUSES))
    .run();
  const deleted = rawChanges();
  log.info({ deleted }, "Bulk-cleared terminal ACP session history");
  return { deleted };
}

function deleteSession({ pathParams }: RouteHandlerArgs) {
  const id = pathParams?.id as string;

  const manager = getAcpSessionManager();
  try {
    const state = manager.getStatus(id);
    if (!Array.isArray(state)) {
      if (state.status === "running" || state.status === "initializing") {
        // A genuinely active session (prompt in flight) must not be deleted —
        // tearing it down would orphan the running prompt. The caller must
        // cancel/close it first.
        throw new ConflictError(
          `ACP session "${id}" is still ${state.status}. Cancel or close it before deleting.`,
        );
      }
      if (state.status === "idle") {
        // An idle session is terminal-for-affordances on the client, but its
        // adapter process, idle timer, and map entry are still live. Close it
        // (cycle-1 idle teardown: kill process, clear timer, drop the map
        // entry, skip re-persisting the already-written `completed` row) before
        // removing its history row, so the delete is consistent — no 409, and
        // it does not reappear on the next `/acp/sessions` refresh.
        manager.close(id);
      }
    }
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    // Not in memory — fall through to the (idempotent) DB delete.
  }

  getDb().delete(acpSessionHistory).where(eq(acpSessionHistory.id, id)).run();
  const deleted = rawChanges() > 0;
  log.info({ acpSessionId: id, deleted }, "ACP session history delete");
  return { deleted };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "acp_spawn",
    endpoint: "acp/spawn",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: spawnSession,
    summary: "Spawn ACP session",
    description: "Start a new Agent Communication Protocol session.",
    tags: ["acp"],
    requestBody: z.object({
      agent: z.string().describe("Agent name"),
      task: z.string().describe("Task description"),
      conversationId: z.string(),
      cwd: z.string().describe("Working directory").optional(),
    }),
    responseBody: z.object({
      acpSessionId: z.string(),
      protocolSessionId: z.string(),
      agent: z.string(),
    }),
  },
  {
    operationId: "acp_link_credential",
    endpoint: "acp/credentials/link",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: linkCredential,
    summary: "Link a per-user ACP/dev credential",
    description:
      "Write a BYO ACP credential (Claude OAuth token, Anthropic/OpenAI API " +
      "key, or git token) into the pod's secure store for the agent spawn " +
      "path to read. Write-only: the value is never returned in the response " +
      "and never sent centrally. Stored under acp/<field> with an " +
      "acp_spawn-only policy.",
    tags: ["acp"],
    requestBody: z.object({
      field: z
        .enum(LINKABLE_ACP_FIELDS)
        .describe("Which ACP credential to link"),
      value: z.string().min(1).describe("Secret value to store (write-only)"),
    }),
    responseBody: z.object({
      field: z.string(),
      linked: z.boolean(),
    }),
  },
  {
    operationId: "acp_steer",
    endpoint: "acp/:id/steer",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: steerSession,
    summary: "Steer ACP session",
    description: "Send a steering instruction to an active ACP session.",
    tags: ["acp"],
    requestBody: z.object({
      instruction: z.string(),
    }),
    responseBody: z.object({
      acpSessionId: z.string(),
      steered: z.boolean(),
    }),
  },
  {
    operationId: "acp_continue",
    endpoint: "acp/continue",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: continueSession,
    summary: "Continue ACP session",
    description:
      "Send a follow-up turn to an existing idle ACP session so the agent " +
      "builds on the same context and workspace. Resolve the target by " +
      "explicit acpSessionId, or by the conversation's most-recent live " +
      "session via conversationId. Errors cleanly (404) for a closed or " +
      "non-existent session, and (409) when the session is busy with a " +
      "prompt still in flight.",
    tags: ["acp"],
    requestBody: z.object({
      instruction: z.string().describe("The follow-up task for this turn"),
      acpSessionId: z
        .string()
        .describe("Explicit live session to continue")
        .optional(),
      conversationId: z
        .string()
        .describe(
          "Resolve the most-recent live session for this conversation when acpSessionId is omitted",
        )
        .optional(),
    }),
    responseBody: z.object({
      acpSessionId: z.string(),
      continued: z.boolean(),
    }),
  },
  {
    operationId: "acp_cancel",
    endpoint: "acp/:id/cancel",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: cancelSession,
    summary: "Cancel ACP session",
    description: "Cancel an active ACP session.",
    tags: ["acp"],
    responseBody: z.object({
      acpSessionId: z.string(),
      cancelled: z.boolean(),
    }),
  },
  {
    operationId: "acp_close",
    endpoint: "acp/:id/close",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: closeSession,
    summary: "Close ACP session",
    description: "Close a completed ACP session.",
    tags: ["acp"],
    responseBody: z.object({
      acpSessionId: z.string(),
      closed: z.boolean(),
    }),
  },
  {
    operationId: "acp_list_sessions",
    endpoint: "acp/sessions",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: listSessions,
    summary: "List ACP sessions",
    description:
      "Return the merged set of in-memory and persisted ACP sessions, " +
      "newest first. In-memory sessions take precedence on id collision.",
    tags: ["acp"],
    queryParams: [
      {
        name: "limit",
        type: "integer",
        required: false,
        description: `Maximum number of sessions to return (default ${DEFAULT_SESSION_LIMIT}, max ${MAX_SESSION_LIMIT}).`,
      },
      {
        name: "conversationId",
        type: "string",
        required: false,
        description:
          "Filter to sessions whose parentConversationId matches this value.",
      },
    ],
    responseBody: z.object({
      sessions: z
        .array(sessionEntrySchema)
        .describe("Merged in-memory and persisted ACP sessions."),
    }),
  },
  {
    operationId: "acp_bulk_delete_sessions",
    endpoint: "acp/sessions",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: bulkDeleteSessions,
    summary: "Bulk-clear terminal ACP sessions",
    description:
      "Remove every terminal-state row (completed/failed/cancelled) from " +
      "the persisted acp_session_history table.",
    tags: ["acp"],
    queryParams: [
      {
        name: "status",
        required: true,
        description:
          "Must be 'completed'. Shorthand for all terminal statuses (completed/failed/cancelled).",
      },
    ],
    responseBody: z.object({
      deleted: z.number().int(),
    }),
  },
  {
    operationId: "acp_delete_session",
    endpoint: "acp/sessions/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: deleteSession,
    summary: "Delete ACP session from history",
    description:
      "Remove a persisted ACP session row. Closes (tears down) a live " +
      "`idle` session first so the delete is consistent. Rejects with 409 " +
      "only when the session is still running/initializing in memory; " +
      "idempotent for unknown ids.",
    tags: ["acp"],
    responseBody: z.object({
      deleted: z.boolean(),
    }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLimit(raw: string | null | undefined): number {
  if (raw == null) return DEFAULT_SESSION_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_LIMIT;
  return Math.min(Math.floor(n), MAX_SESSION_LIMIT);
}

function listMergedSessions(opts: {
  limit: number;
  conversationId?: string;
}): SessionEntry[] {
  const manager = getAcpSessionManager();
  const inMemory = manager.getStatus() as AcpSessionState[];

  const merged = new Map<string, SessionEntry>();
  for (const s of inMemory) {
    if (opts.conversationId && s.parentConversationId !== opts.conversationId) {
      continue;
    }
    merged.set(s.id, {
      id: s.id,
      agentId: s.agentId,
      acpSessionId: s.acpSessionId,
      parentConversationId: s.parentConversationId,
      status: s.status,
      startedAt: s.startedAt,
      completedAt: s.completedAt ?? null,
      error: s.error ?? null,
      stopReason: s.stopReason ?? null,
    });
  }

  const db = getDb();
  const baseQuery = db.select().from(acpSessionHistory);
  const filtered = opts.conversationId
    ? baseQuery.where(
        eq(acpSessionHistory.parentConversationId, opts.conversationId),
      )
    : baseQuery;
  // Fetch only enough rows to fill the requested page after merging with
  // in-memory sessions. In-memory entries take precedence on id collision,
  // so we pad by the count that survived the conversation filter to
  // guarantee we still surface `limit` distinct rows even when every
  // in-memory session shadows a DB row — without over-fetching when many
  // unrelated sessions are in memory.
  const historyRows = filtered
    .orderBy(desc(acpSessionHistory.startedAt))
    .limit(opts.limit + merged.size)
    .all();

  for (const row of historyRows) {
    if (merged.has(row.id)) continue;
    let eventLog: unknown[] = [];
    try {
      const parsed = JSON.parse(row.eventLogJson) as unknown;
      if (Array.isArray(parsed)) eventLog = parsed;
    } catch (err) {
      log.warn(
        { id: row.id, err },
        "Failed to parse event_log_json for ACP session history row",
      );
    }
    merged.set(row.id, {
      id: row.id,
      agentId: row.agentId,
      acpSessionId: row.acpSessionId,
      parentConversationId: row.parentConversationId,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      error: row.error,
      stopReason: row.stopReason,
      eventLog,
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, opts.limit);
}
