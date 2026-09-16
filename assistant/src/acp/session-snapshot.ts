import { desc, eq } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { acpSessionHistory } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import { acpAuthMarkerStillCurrent } from "./acp-auth-marker-store.js";
import { getAcpSessionManager } from "./index.js";
import type { AcpSessionManager } from "./session-manager.js";
import type { AcpSessionState } from "./types.js";

const log = getLogger("acp:session-snapshot");

export interface AcpSessionSnapshot {
  id: string;
  agentId: string;
  acpSessionId: string;
  parentConversationId: string;
  status: string;
  startedAt: number;
  completedAt?: number | null;
  error?: string | null;
  stopReason?: string | null;
  task?: string;
  parentToolUseId?: string;
  authErrorCode?: string;
  authErrorCredential?: string;
  model?: string;
  availableModels?: AcpSessionState["availableModels"];
  modelRevisionEpoch?: string;
  modelRevision?: number;
  usedTokens?: number;
  contextSize?: number;
  costAmount?: number;
  costCurrency?: string;
  inputTokens?: number;
  outputTokens?: number;
  eventLog?: unknown[];
  source: "live" | "history";
  resumable: boolean;
  cwd?: string | null;
}

export interface AcpSessionSnapshotPage {
  sessions: AcpSessionSnapshot[];
  sawEveryHistoryRow: boolean;
}

interface SnapshotOptions {
  includeEventLog?: boolean;
}

function fromLiveState(
  state: AcpSessionState,
  manager: AcpSessionManager,
  opts: SnapshotOptions,
): AcpSessionSnapshot {
  return {
    id: state.id,
    agentId: state.agentId,
    acpSessionId: state.acpSessionId,
    parentConversationId: state.parentConversationId,
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt ?? null,
    error: state.error ?? null,
    stopReason: state.stopReason ?? null,
    task: state.task,
    parentToolUseId: state.parentToolUseId,
    authErrorCode: state.authErrorCode,
    authErrorCredential: state.authErrorCredential,
    model: state.model,
    availableModels: state.availableModels,
    modelRevisionEpoch: state.modelRevisionEpoch,
    modelRevision: state.modelRevision,
    usedTokens: state.latestUsage?.usedTokens,
    contextSize: state.latestUsage?.contextSize,
    costAmount: state.latestUsage?.costAmount,
    costCurrency: state.latestUsage?.costCurrency,
    inputTokens: state.latestUsage?.inputTokens,
    outputTokens: state.latestUsage?.outputTokens,
    eventLog: opts.includeEventLog
      ? manager.getBufferedUpdates(state.id)
      : undefined,
    source: "live",
    resumable: false,
  };
}

function isResumableHistoryRow(
  row: typeof acpSessionHistory.$inferSelect,
): boolean {
  return Boolean(row.cwd && row.acpSessionId);
}

export function snapshotHistoryRow(
  row: typeof acpSessionHistory.$inferSelect,
  opts: SnapshotOptions = { includeEventLog: true },
): AcpSessionSnapshot {
  let eventLog: unknown[] | undefined;
  if (opts.includeEventLog !== false) {
    eventLog = [];
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
  }

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
    source: "history",
    resumable: isResumableHistoryRow(row),
    cwd: row.cwd,
  };
}

/**
 * Blank `authErrorCode` on any session whose marker no longer describes the
 * credential its agent would resolve.
 *
 * This comparison is what retires a Connect card: the marker no longer
 * describing the credential in use. Applied after merging rather than inside
 * the query, so live sessions and history rows are judged by the same rule.
 *
 * Resolved per agent and memoised across the batch, because precedence is per
 * agent and each resolution costs a vault read.
 */
export async function withCurrentAuthMarkers<
  T extends {
    agentId: string;
    authErrorCode?: string;
    authErrorCredential?: string;
  },
>(
  sessions: readonly T[],
  resolvedFor: (agentId: string) => Promise<string | undefined>,
): Promise<T[]> {
  if (!sessions.some((session) => session.authErrorCode !== undefined)) {
    return [...sessions];
  }
  const resolvedByAgent = new Map<string, string | undefined>();
  const resolve = async (agentId: string) => {
    if (!resolvedByAgent.has(agentId)) {
      resolvedByAgent.set(agentId, await resolvedFor(agentId));
    }
    return resolvedByAgent.get(agentId);
  };
  const judged: T[] = [];
  for (const session of sessions) {
    if (session.authErrorCode === undefined) {
      judged.push(session);
      continue;
    }
    const current = acpAuthMarkerStillCurrent(
      session.authErrorCredential,
      await resolve(session.agentId),
    );
    judged.push(
      current ? session : { ...session, authErrorCode: undefined },
    );
  }
  return judged;
}

export function getAcpSessionSnapshot(
  acpSessionId: string,
  opts: SnapshotOptions = {},
): AcpSessionSnapshot | undefined {
  const manager = getAcpSessionManager();
  const snapshotOptions = {
    includeEventLog: opts.includeEventLog ?? true,
  };
  const live = (manager.getStatus() as AcpSessionState[]).find(
    (state) => state.id === acpSessionId,
  );
  if (live) {
    return fromLiveState(live, manager, snapshotOptions);
  }

  const row = getDb()
    .select()
    .from(acpSessionHistory)
    .where(eq(acpSessionHistory.id, acpSessionId))
    .get();
  return row ? snapshotHistoryRow(row, snapshotOptions) : undefined;
}

export function listAcpSessionSnapshots(opts: {
  limit: number;
  conversationId?: string;
  includeEventLog?: boolean;
}): AcpSessionSnapshotPage {
  const manager = getAcpSessionManager();
  const inMemory = manager.getStatus() as AcpSessionState[];
  const snapshotOptions = {
    includeEventLog: opts.includeEventLog ?? true,
  };

  const merged = new Map<string, AcpSessionSnapshot>();
  for (const state of inMemory) {
    if (
      opts.conversationId &&
      state.parentConversationId !== opts.conversationId
    ) {
      continue;
    }
    merged.set(state.id, fromLiveState(state, manager, snapshotOptions));
  }

  const db = getDb();
  const baseQuery = db.select().from(acpSessionHistory);
  const filtered = opts.conversationId
    ? baseQuery.where(
        eq(acpSessionHistory.parentConversationId, opts.conversationId),
      )
    : baseQuery;
  const historyLimit = opts.limit + merged.size;
  const historyRows = filtered
    .orderBy(desc(acpSessionHistory.startedAt))
    .limit(historyLimit)
    .all();

  for (const row of historyRows) {
    if (!merged.has(row.id)) {
      merged.set(row.id, snapshotHistoryRow(row, snapshotOptions));
    }
  }

  return {
    sessions: Array.from(merged.values()).sort(
      (a, b) => b.startedAt - a.startedAt,
    ),
    sawEveryHistoryRow: historyRows.length < historyLimit,
  };
}
