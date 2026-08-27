/**
 * Route handlers for ACP (Agent Communication Protocol) session lifecycle.
 *
 * Exposes spawn, steer, cancel, close, sessions, and permission operations
 * over HTTP and IPC.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { z } from "zod";

import {
  acpAuthMarkerStillCurrent,
  MARKER_SCAN_LIMIT,
} from "../../acp/acp-auth-marker-store.js";
import { resolveAgentWithAutoInstall } from "../../acp/auto-install.js";
import { getAcpSessionManager } from "../../acp/index.js";
import {
  prepareAgentEnv,
  resolvedClaudeCredentialDigest,
} from "../../acp/prepare-agent-env.js";
import { formatResolveFailure } from "../../acp/resolve-agent.js";
import {
  AcpResumeError,
  AcpSessionNotFoundError,
} from "../../acp/session-manager.js";
import type { AcpSessionState } from "../../acp/types.js";
import type { AssistantEvent } from "../../api/index.js";
import { getConfig } from "../../config/loader.js";
import { createGuardianRequestForConfirmation } from "../../permissions/confirmation-guardian-request.js";
import type { UserDecision } from "../../permissions/types.js";
import { getDb } from "../../persistence/db-connection.js";
import { rawChanges } from "../../persistence/raw-query.js";
import { acpSessionHistory } from "../../persistence/schema/index.js";
import { getLogger } from "../../util/logger.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import * as pendingInteractions from "../pending-interactions.js";
import {
  BadRequestError,
  ConflictError,
  FailedDependencyError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const TERMINAL_SESSION_STATUSES = ["completed", "failed", "cancelled"] as const;

const log = getLogger("acp-routes");

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;

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
  task: z.string().optional(),
  parentToolUseId: z.string().optional(),
  /** Credential failure that ended the run, when one did. Drives the inline
   *  Connect card on reopen; cleared when a replacement token is stored. */
  authErrorCode: z.string().optional(),
  usedTokens: z.number().optional(),
  contextSize: z.number().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  eventLog: z.array(z.unknown()).optional(),
});

type SessionEntry = z.infer<typeof sessionEntrySchema>;

/**
 * A merged session before its marker has been judged.
 *
 * `authErrorCredential` names the credential the failure was refused on. It is
 * what the comparison needs and is dropped before the response goes out: a
 * client has no use for it and no way to resolve the other side of the
 * comparison, so serving it would only widen what leaves the daemon.
 */
type MergedSession = SessionEntry & { authErrorCredential?: string };

/** Drop the comparison's own input before the session goes out on the wire. */
function stripMarkerCredential({
  authErrorCredential: _dropped,
  ...session
}: MergedSession): SessionEntry {
  return session;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Surface a high-risk confirmation for an ACP route that starts a host agent
 * subprocess (`POST /v1/acp/spawn`, and the resume branch of
 * `POST /v1/acp/:id/steer`) and resolve to the guardian's decision.
 *
 * Unlike the `acp_spawn` / `acp_steer` skill tools (which are dispatched
 * through `ToolExecutor`/`PermissionChecker` and so inherit the descriptors'
 * `risk: "high"` approval prompt), these HTTP/IPC routes reach the ACP
 * session manager directly. A spawned ACP agent is a host subprocess with
 * advertised filesystem + terminal access whose in-session permission
 * requests are auto-allowed, so starting one is exactly the high-risk action
 * the descriptors gate. Without this prompt a caller holding only
 * `chat.write` could start one with no human in the loop — directly via
 * spawn (arbitrary `cwd`), or by resuming a terminal session via steer (its
 * persisted `cwd`, enumerable through `GET /v1/acp/sessions`) (ATL-822).
 *
 * The confirmation is registered with `directResolve` so `POST /v1/confirm`
 * resolves it without a live `Conversation` object. That route requires the
 * bound guardian (`approval.write` + `requireGuardian`) — a strictly higher
 * bar than the `chat.write` these routes demand — so the `chat.write` caller
 * cannot self-approve. Timeout and client disconnect both deny, matching the
 * tool path's "no interactive client → do not run" posture.
 */
function awaitRouteApproval(args: {
  toolName: string;
  input: Record<string, unknown>;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<UserDecision> {
  const { toolName, input, conversationId, signal } = args;
  const requestId = randomUUID();
  // Mirror the interactive prompt timeout; fall back to the schema default
  // (300s) if the timeouts block is somehow absent so the gate never wedges.
  const timeoutMs = (getConfig().timeouts?.permissionTimeoutSec ?? 300) * 1000;

  return new Promise<UserDecision>((resolve) => {
    let settled = false;
    const settle = (
      decision: UserDecision,
      state: "approved" | "rejected" | "cancelled",
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Idempotent: the `/v1/confirm` directResolve path already removed the
      // entry before invoking us, so this is a no-op there and only fires
      // `interaction_resolved` for the timeout/abort paths.
      pendingInteractions.resolve(requestId, state);
      resolve(decision);
    };

    const timer = setTimeout(() => {
      log.warn(
        { requestId, toolName, conversationId },
        "ACP route approval timed out — denying",
      );
      settle("deny", "cancelled");
    }, timeoutMs);

    const onAbort = () => settle("deny", "cancelled");
    if (signal?.aborted) {
      clearTimeout(timer);
      resolve("deny");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    pendingInteractions.register(requestId, {
      conversationId,
      kind: "confirmation",
      confirmationDetails: {
        toolName,
        input,
        riskLevel: "high",
        executionTarget: "host",
        allowlistOptions: [],
        scopeOptions: [],
        persistentDecisionsAllowed: false,
      },
      directResolve: (decision) =>
        settle(decision, decision === "allow" ? "approved" : "rejected"),
    });

    const confirmationMsg: AssistantEvent & {
      type: "confirmation_request";
    } = {
      type: "confirmation_request",
      requestId,
      toolName,
      input,
      riskLevel: "high",
      executionTarget: "host",
      allowlistOptions: [],
      scopeOptions: [],
      conversationId,
      persistentDecisionsAllowed: false,
    };
    broadcastMessage(confirmationMsg, conversationId);

    // Promote the confirmation to a guardian request so channel
    // guardian decisions (reactions, buttons, text) can resolve it.
    void createGuardianRequestForConfirmation(confirmationMsg, conversationId);
  });
}

async function spawnSession({ body, abortSignal }: RouteHandlerArgs) {
  const agent = body?.agent as string | undefined;
  const task = body?.task as string | undefined;
  const conversationId = body?.conversationId as string | undefined;
  const cwd = (body?.cwd as string | undefined) ?? process.cwd();

  if (!agent || !task || !conversationId) {
    throw new BadRequestError("agent, task, and conversationId are required");
  }

  // High-risk approval gate. Block BEFORE any side effects — resolution can
  // trigger a `bun` global install (auto-install.ts) and `manager.spawn`
  // launches the host subprocess — so an unapproved request mutates nothing.
  const decision = await awaitRouteApproval({
    toolName: "acp_spawn",
    input: { agent, task, cwd },
    conversationId,
    signal: abortSignal,
  });
  if (decision !== "allow") {
    throw new ForbiddenError(
      "Spawning an ACP coding agent requires guardian approval, which was " +
        "not granted.",
    );
  }

  // Resolve the agent, silently auto-installing a missing allowlisted
  // adapter binary (see acp/auto-install.ts). Shared with the skill-tool
  // path in tools/acp/spawn.ts; only the transport mapping differs.
  const { resolved, failureMessage } = await resolveAgentWithAutoInstall(agent);
  if (failureMessage) {
    throw new FailedDependencyError(failureMessage);
  }
  if (!resolved.ok) {
    const message = formatResolveFailure(agent, resolved);
    if (resolved.reason === "binary_not_found") {
      throw new FailedDependencyError(message);
    }
    throw new BadRequestError(message);
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

async function steerSession({ pathParams, body }: RouteHandlerArgs) {
  const id = pathParams?.id as string;
  const instruction = body?.instruction as string | undefined;

  if (!instruction) {
    throw new BadRequestError("instruction is required");
  }

  // Sessions no longer in memory (completed, or lost to a daemon restart)
  // are transparently resumed from persisted history with the instruction
  // fired in the same call, mirroring the acp_steer skill tool.
  // broadcastMessage plays the sender role spawnSession gives it, so
  // connected clients render the session.
  const manager = getAcpSessionManager();

  // Resume re-spawns the host agent subprocess, so it crosses the same
  // high-risk boundary as spawn and needs guardian approval (ATL-822). A
  // steer of a session still active in memory only redirects an
  // already-running, already-approved process, so it is left unprompted —
  // matching "gate before spawning". A resume only happens when the id is
  // absent from memory AND a resumable history row (non-null cwd) exists.
  if (!manager.getActiveAndPendingIds().includes(id)) {
    const resumable = getDb()
      .select({
        cwd: acpSessionHistory.cwd,
        agentId: acpSessionHistory.agentId,
        parentConversationId: acpSessionHistory.parentConversationId,
      })
      .from(acpSessionHistory)
      .where(eq(acpSessionHistory.id, id))
      .get();
    if (resumable?.cwd != null) {
      // Guardian approval is an out-of-band human action that can take far
      // longer than a client's ack timeout (the macOS client uses 10s; the
      // approval window is permissionTimeoutSec, default 300s). Blocking the
      // HTTP response here would surface as a client transport failure even
      // on an eventual approval. Acknowledge immediately and run approval +
      // resume in the background, streaming via SSE like any other ACP
      // activity. The request abortSignal is deliberately NOT threaded into
      // the wait — the request is already complete.
      void approveThenResume({
        id,
        instruction,
        agentId: resumable.agentId,
        cwd: resumable.cwd,
        conversationId: resumable.parentConversationId,
      });
      return { acpSessionId: id, steered: false, approvalPending: true };
    }
  }

  try {
    const { resumed } = await manager.steerOrResume(
      id,
      instruction,
      broadcastMessage,
    );
    return resumed
      ? { acpSessionId: id, steered: true, resumed: true }
      : { acpSessionId: id, steered: true };
  } catch (err) {
    // Resume errors carry the actionable hint (legacy row without cwd,
    // agent capability missing, resolver failures, ...).
    if (err instanceof AcpResumeError) {
      throw new FailedDependencyError(err.message);
    }
    // Unknown ids (no in-memory session, no history row) and plain steer
    // failures both map to 404, as before.
    throw new NotFoundError("ACP session not found");
  }
}

/**
 * Background worker for an approval-gated ACP resume initiated over the steer
 * route. Awaits the guardian decision (see `awaitRouteApproval`), then resumes
 * via the session manager so the agent's output streams back over SSE. A
 * denial, timeout, or resume failure is surfaced as an `acp_session_error` on
 * the parent conversation so the client isn't left with an optimistic steer
 * row and no follow-up. Never throws — it owns the request lifecycle after the
 * route has already acked.
 */
async function approveThenResume(args: {
  id: string;
  instruction: string;
  agentId: string;
  cwd: string;
  conversationId: string;
}): Promise<void> {
  const decision = await awaitRouteApproval({
    toolName: "acp_steer",
    input: {
      acp_session_id: args.id,
      instruction: args.instruction,
      agent: args.agentId,
      cwd: args.cwd,
    },
    conversationId: args.conversationId,
  });

  if (decision !== "allow") {
    log.info(
      { acpSessionId: args.id, conversationId: args.conversationId },
      "ACP resume approval not granted — skipping resume",
    );
    broadcastMessage(
      {
        type: "acp_session_error",
        // Key the error by the daemon session id (the value the steer route
        // accepts and ACP SSE consumers index by — see registerSession, where
        // state.id is the broadcast acpSessionId), NOT the persisted protocol
        // id. A denied resume never emits acp_session_spawned to map the
        // protocol id, so a protocol-keyed error would be dropped.
        acpSessionId: args.id,
        error: "Resume was not approved.",
      },
      args.conversationId,
    );
    return;
  }

  try {
    await getAcpSessionManager().steerOrResume(
      args.id,
      args.instruction,
      broadcastMessage,
    );
  } catch (err) {
    const message =
      err instanceof AcpResumeError || err instanceof Error
        ? err.message
        : String(err);
    log.warn(
      { acpSessionId: args.id, conversationId: args.conversationId, err },
      "Approved ACP resume failed",
    );
    broadcastMessage(
      {
        type: "acp_session_error",
        // Daemon session id (route + SSE key), not the protocol id — see above.
        acpSessionId: args.id,
        error: message,
      },
      args.conversationId,
    );
  }
}

async function cancelSession({ pathParams }: RouteHandlerArgs) {
  const id = pathParams?.id as string;
  const manager = getAcpSessionManager();
  try {
    await manager.cancel(id);
  } catch (err) {
    // Only a genuinely unknown session is a 404. A protocol-cancel failure on a
    // still-live session is a real error, not a missing session, so it surfaces
    // as a 500 rather than a misleading not-found.
    if (err instanceof AcpSessionNotFoundError) {
      throw new NotFoundError("ACP session not found");
    }
    throw new InternalError(
      err instanceof Error ? err.message : "Failed to cancel ACP session",
    );
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

async function listSessions({ queryParams }: RouteHandlerArgs) {
  const limit = parseLimit(queryParams?.limit);
  const conversationId = queryParams?.conversationId;
  // Resolved per agent, because precedence is per agent: one alias can carry a
  // configured token while another falls through to the vault. Memoised across
  // the request, since each resolution costs a vault read and a conversation's
  // marked runs are nearly always one agent.
  const resolvedByAgent = new Map<string, string | undefined>();
  const resolvedFor = async (agentId: string) => {
    if (!resolvedByAgent.has(agentId)) {
      resolvedByAgent.set(
        agentId,
        await resolvedClaudeCredentialDigest(agentId),
      );
    }
    return resolvedByAgent.get(agentId);
  };

  const { sessions: merged, sawEveryHistoryRow } = listMergedSessions({
    limit,
    conversationId,
  });
  // Judged before paging, never after. A stale marker that escaped the page
  // first would stay in the response as an ordinary row once its code was
  // struck, so the retained markers would pile up past the limit.
  const judged = await withCurrentMarkersOnly(merged, resolvedFor);
  const page = judged.slice(0, limit);
  if (!conversationId || page.some((s) => s.authErrorCode !== undefined)) {
    return { sessions: page };
  }
  // Rows the page cut that are already in hand. In-memory sessions merge in on
  // top of the history read, so the merged list can overflow the page even
  // when the query reached the end of the table, and the marker the client
  // needs can be sitting in that overflow. Newest-first, so the first match is
  // the one to surface.
  const overflowMarker = judged
    .slice(limit)
    .find((s) => s.authErrorCode !== undefined);
  if (overflowMarker) {
    return { sessions: [...page, overflowMarker] };
  }
  if (sawEveryHistoryRow) {
    // Every row this conversation has has now been looked at, page and
    // overflow alike, so a marker elsewhere is not a thing that exists. Most
    // conversations have never had a credential failure, and this is what
    // keeps the lookup off their path rather than asking the database to
    // confirm the absence every time.
    return { sessions: page };
  }
  // The page holds no live marker, so the row a client restores the card from
  // is either outside it or absent. One row, fetched only now, rather than
  // every marked row loaded on the chance one of them is needed.
  const marker = await findRecoveryMarker(conversationId, resolvedFor);
  if (!marker || page.some((s) => s.id === marker.id)) {
    return { sessions: page };
  }
  return { sessions: [...page, stripMarkerCredential(marker)] };
}

/**
 * Blank the failure code on any session whose marker no longer describes the
 * credential its agent would resolve.
 *
 * This comparison is what retires a Connect card: not a sweep that has to run
 * at the right moment, but the marker no longer describing the credential in
 * use. Applied after merging rather than inside the query, so live sessions
 * and history rows are judged by exactly the same rule.
 *
 * Resolved per agent, because precedence is per agent: one alias can carry a
 * configured token while another falls through to the vault. Memoised across
 * the request, since a conversation's marked runs are nearly always one agent
 * and each resolution costs a vault read.
 */
async function withCurrentMarkersOnly(
  sessions: MergedSession[],
  resolvedFor: (agentId: string) => Promise<string | undefined>,
): Promise<SessionEntry[]> {
  const strip = stripMarkerCredential;
  if (!sessions.some((s) => s.authErrorCode !== undefined)) {
    return sessions.map(strip);
  }
  const judged: SessionEntry[] = [];
  for (const session of sessions) {
    if (session.authErrorCode === undefined) {
      judged.push(strip(session));
      continue;
    }
    const current = acpAuthMarkerStillCurrent(
      session.authErrorCredential,
      await resolvedFor(session.agentId),
    );
    judged.push(
      strip(current ? session : { ...session, authErrorCode: undefined }),
    );
  }
  return judged;
}

function bulkDeleteSessions({ queryParams }: RouteHandlerArgs) {
  const status = queryParams?.status;
  if (status !== "completed") {
    throw new BadRequestError(
      "status query param is required and must be 'completed'",
    );
  }
  // Exclude sessions currently active in memory AND ids with a resume in
  // flight (reserved but not yet registered): a resumed session reuses its
  // original id, and its history row keeps the old terminal status until
  // the next terminal upsert - a status-only delete would remove the row
  // out from under the live (or resuming) session, and the later terminal
  // upsert would resurrect it. Mirrors the 409 guard on the single-id
  // delete route.
  const activeIds = getAcpSessionManager().getActiveAndPendingIds();
  const terminalFilter = inArray(
    acpSessionHistory.status,
    TERMINAL_SESSION_STATUSES,
  );
  getDb()
    .delete(acpSessionHistory)
    .where(
      activeIds.length > 0
        ? and(terminalFilter, notInArray(acpSessionHistory.id, activeIds))
        : terminalFilter,
    )
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
    if (
      !Array.isArray(state) &&
      (state.status === "running" || state.status === "initializing")
    ) {
      throw new ConflictError(
        `ACP session "${id}" is still ${state.status}. Cancel or close it before deleting.`,
      );
    }
  } catch (err) {
    if (err instanceof ConflictError) {
      throw err;
    }
    // Not registered in memory, but a resume may be in flight (id reserved
    // while awaiting env preparation). Its history row must survive until
    // the resume lands - the later terminal upsert would resurrect a
    // deleted row.
    if (manager.getActiveAndPendingIds().includes(id)) {
      throw new ConflictError(
        `ACP session "${id}" has a resume in flight. Wait for it to finish before deleting.`,
      );
    }
    // Otherwise fall through to the (idempotent) DB delete.
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
    operationId: "acp_steer",
    endpoint: "acp/:id/steer",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: steerSession,
    summary: "Steer ACP session",
    description:
      "Send a steering instruction to an ACP session. Sessions no longer " +
      "in memory (completed, or lost to a daemon restart) are " +
      "transparently resumed from persisted history first, when the agent " +
      "supports ACP session loading. Resuming a terminal session re-spawns " +
      "the host agent, so it requires guardian approval: the route acks " +
      "immediately with approvalPending=true and performs the resume in the " +
      "background once approved, streaming results over SSE.",
    tags: ["acp"],
    requestBody: z.object({
      instruction: z.string(),
    }),
    responseBody: z.object({
      acpSessionId: z.string(),
      steered: z.boolean(),
      resumed: z
        .boolean()
        .optional()
        .describe(
          "True when the session was resumed from persisted history before steering.",
        ),
      approvalPending: z
        .boolean()
        .optional()
        .describe(
          "True when the steer triggered a guardian-approval-gated resume " +
            "that will run asynchronously; watch SSE for the outcome.",
        ),
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
      "the persisted acp_session_history table. Rows whose session is " +
      "currently active in memory (e.g. resumed) or has a resume in " +
      "flight are excluded.",
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
      "Remove a persisted ACP session row. Rejects with 409 when the " +
      "session is still active in memory or has a resume in flight; " +
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
  if (raw == null) {
    return DEFAULT_SESSION_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_SESSION_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_SESSION_LIMIT);
}

function listMergedSessions(opts: { limit: number; conversationId?: string }): {
  sessions: MergedSession[];
  /**
   * Whether the history query reached the end of this conversation's rows.
   *
   * A short read means there is nothing beyond what was returned, which is the
   * proof that no marker is hiding outside the page.
   */
  sawEveryHistoryRow: boolean;
} {
  const manager = getAcpSessionManager();
  const inMemory = manager.getStatus() as AcpSessionState[];

  const merged = new Map<string, MergedSession>();
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
      task: s.task,
      parentToolUseId: s.parentToolUseId,
      authErrorCode: s.authErrorCode,
      authErrorCredential: s.authErrorCredential,
      usedTokens: s.latestUsage?.usedTokens,
      contextSize: s.latestUsage?.contextSize,
      costAmount: s.latestUsage?.costAmount,
      costCurrency: s.latestUsage?.costCurrency,
      inputTokens: s.latestUsage?.inputTokens,
      outputTokens: s.latestUsage?.outputTokens,
      eventLog: manager.getBufferedUpdates(s.id),
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
  const historyLimit = opts.limit + merged.size;
  const historyRows = filtered
    .orderBy(desc(acpSessionHistory.startedAt))
    .limit(historyLimit)
    .all();

  for (const row of historyRows) {
    if (merged.has(row.id)) {
      continue;
    }
    merged.set(row.id, toMergedSession(row));
  }

  return {
    sessions: Array.from(merged.values()).sort(
      (a, b) => b.startedAt - a.startedAt,
    ),
    sawEveryHistoryRow: historyRows.length < historyLimit,
  };
}

/** Shape a history row for the response, parsing its stored event log. */
function toMergedSession(
  row: typeof acpSessionHistory.$inferSelect,
): MergedSession {
  let eventLog: unknown[] = [];
  try {
    const parsed = JSON.parse(row.eventLogJson) as unknown;
    if (Array.isArray(parsed)) {
      eventLog = parsed;
    }
  } catch (err) {
    log.warn(
      { id: row.id, err },
      "Failed to parse event_log_json for ACP session history row",
    );
  }
  // Rows predating the usage migration carry NULLs for these columns and
  // degrade to undefined.
  return {
    id: row.id,
    agentId: row.agentId,
    acpSessionId: row.acpSessionId,
    parentConversationId: row.parentConversationId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    stopReason: row.stopReason,
    task: row.task ?? undefined,
    parentToolUseId: row.parentToolUseId ?? undefined,
    authErrorCode: row.authErrorCode ?? undefined,
    authErrorCredential: row.authErrorCredential ?? undefined,
    usedTokens: row.usedTokens ?? undefined,
    contextSize: row.contextSize ?? undefined,
    costAmount: row.costAmount ?? undefined,
    costCurrency: row.costCurrency ?? undefined,
    inputTokens: row.inputTokens ?? undefined,
    outputTokens: row.outputTokens ?? undefined,
    eventLog,
  };
}

/**
 * Reach past the page for the one marked run a client would restore the card
 * from, when the page itself holds none.
 *
 * Paging it out is the difference between a user having a way back to auth and
 * not: a conversation with more recent runs than the page holds would
 * otherwise hide the one row that matters.
 *
 * Asks the database for that row rather than filtering one that was loaded.
 * Nothing clears a marker, so repeated failures against a credential that is
 * still current accumulate them, and loading every marked row would pull a
 * full event log apiece into memory to parse and then discard. This reads the
 * credential of each marked row (a column, no event log), resolves what its
 * agent would use now, and only then loads the single row that wins.
 *
 * Bounded by the number of distinct agents a conversation has failed under,
 * which is one in practice, rather than by how often it has failed.
 */
async function findRecoveryMarker(
  conversationId: string,
  resolvedFor: (agentId: string) => Promise<string | undefined>,
): Promise<MergedSession | undefined> {
  const db = getDb();
  // One ordered read of the newest markers, then the answer is decided in
  // memory. Filtering by agent and credential in SQL meant the planner could
  // only seek to the conversation and then walk its marked history looking for
  // a match, so a run of failures against a replaced credential put that walk
  // back on every snapshot. This shape is the one the index serves: seek,
  // read in order, stop.
  const markers = db
    .select({
      id: acpSessionHistory.id,
      agentId: acpSessionHistory.agentId,
      credential: acpSessionHistory.authErrorCredential,
    })
    .from(acpSessionHistory)
    .where(
      and(
        eq(acpSessionHistory.parentConversationId, conversationId),
        isNotNull(acpSessionHistory.authErrorCode),
      ),
    )
    .orderBy(desc(acpSessionHistory.startedAt))
    .limit(MARKER_SCAN_LIMIT)
    .all();

  for (const marker of markers) {
    if (
      acpAuthMarkerStillCurrent(
        marker.credential,
        await resolvedFor(marker.agentId),
      )
    ) {
      // Newest-first, so the first match is the one a client would restore
      // from. Only now is the full row worth loading, by primary key.
      const row = db
        .select()
        .from(acpSessionHistory)
        .where(eq(acpSessionHistory.id, marker.id))
        .get();
      return row ? toMergedSession(row) : undefined;
    }
  }
  return undefined;
}
