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
  ACP_SPAWN_TOOL,
  prepareAgentEnv,
} from "../../acp/prepare-agent-env.js";
import { resolveAcpAgent } from "../../acp/resolve-agent.js";
import type { AcpSessionState } from "../../acp/types.js";
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

/**
 * The ONLY credential fields a client may link via `acp/credentials/link`.
 * These are the BYO secrets `prepare-agent-env.ts` reads through the broker
 * when spawning a per-user agent on a hosted pod. The route is intentionally
 * locked to this allowlist so the client-reachable surface can never write
 * (or overwrite) an arbitrary `acp/*` secret outside the agent's needs.
 */
const LINKABLE_ACP_FIELDS = [
  "claude_oauth_token",
  "anthropic_api_key",
  "openai_api_key",
  "git_token",
] as const;

type LinkableAcpField = (typeof LINKABLE_ACP_FIELDS)[number];

const LINKABLE_FIELD_DESCRIPTIONS: Record<LinkableAcpField, string> = {
  claude_oauth_token: "Claude OAuth token for ACP agent authentication",
  anthropic_api_key: "Anthropic API key for ACP agent authentication",
  openai_api_key: "OpenAI API key for ACP agent authentication",
  git_token: "Git access token for ACP agent repository operations",
};

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
  const cwd = (body?.cwd as string | undefined) ?? process.cwd();

  if (!agent || !task || !conversationId) {
    throw new BadRequestError("agent, task, and conversationId are required");
  }

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

  try {
    const state = getAcpSessionManager().getStatus(id);
    if (
      !Array.isArray(state) &&
      (state.status === "running" || state.status === "initializing")
    ) {
      throw new ConflictError(
        `ACP session "${id}" is still ${state.status}. Cancel or close it before deleting.`,
      );
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
      "Remove a persisted ACP session row. Rejects with 409 when the " +
      "session is still active in memory; idempotent for unknown ids.",
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
